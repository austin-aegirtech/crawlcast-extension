/**
 * M3U8 Playlist Parser
 * Handles Master playlists (variants) and Media playlists (segments)
 */

class M3U8Parser {
  constructor() {
    this.baseUrl = '';
  }

  /**
   * Parse m3u8 content
   * @param {string} content - Raw m3u8 text
   * @param {string} baseUrl - Base URL for resolving relative paths
   * @returns {Object} Parsed playlist data
   */
  parse(content, baseUrl) {
    this.baseUrl = baseUrl;
    const lines = content.trim().split('\n').map(l => l.trim()).filter(l => l);
    
    if (!lines[0].includes('#EXTM3U')) {
      throw new Error('Invalid M3U8 file: missing #EXTM3U header');
    }

    const playlist = {
      isMaster: false,
      variants: [],      // For master playlists (different qualities)
      media: [],         // EXT-X-MEDIA renditions (separate audio/subtitle tracks)
      segments: [],      // For media playlists (actual video chunks)
      // fMP4/CMAF-packaged media playlists declare their init segment (the
      // moov box every fragment depends on) via EXT-X-MAP rather than
      // muxing it into each segment — see EXT-X-MAP handling below.
      initSegmentUrl: null,
      metadata: {
        targetDuration: 0,
        mediaSequence: 0,
        version: 1
      }
    };

    let currentVariant = null;
    let currentSegment = {};
    let extinfFound = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      // Skip header
      if (line === '#EXTM3U') continue;

      // Separate audio / subtitle renditions. When a variant references an
      // AUDIO group, its own segments carry VIDEO ONLY — the audio has to be
      // fetched from here or the download is silent.
      if (line.startsWith('#EXT-X-MEDIA:')) {
        const a = this.parseAttributes(line.replace('#EXT-X-MEDIA:', ''));
        playlist.media.push({
          type: a.TYPE || null,
          groupId: a['GROUP-ID'] || null,
          name: a.NAME || null,
          language: a.LANGUAGE || null,
          isDefault: a.DEFAULT === 'YES',
          autoselect: a.AUTOSELECT === 'YES',
          forced: a.FORCED === 'YES',
          channels: a.CHANNELS || null,
          // URI is absent when the track is muxed into the video segments
          url: a.URI ? this.resolveUrl(a.URI) : null
        });
        continue;
      }

      // fMP4/CMAF media playlists point at their init segment (moov) here
      // instead of muxing it into every fragment. Captures the most recent
      // one seen — sufficient for the common case of one init segment per
      // playlist; a playlist with multiple EXT-X-MAP entries across
      // discontinuities would need per-segment tracking, which this does
      // not attempt.
      if (line.startsWith('#EXT-X-MAP:')) {
        const a = this.parseAttributes(line.replace('#EXT-X-MAP:', ''));
        if (a.URI) playlist.initSegmentUrl = this.resolveUrl(a.URI);
        continue;
      }

      // Master playlist indicators
      if (line.startsWith('#EXT-X-STREAM-INF')) {
        currentVariant = this.parseStreamInf(line);
        extinfFound = true;
        continue;
      }

      // Variant URL (master playlist)
      if (currentVariant && extinfFound && !line.startsWith('#')) {
        currentVariant.url = this.resolveUrl(line);
        playlist.variants.push(currentVariant);
        currentVariant = null;
        extinfFound = false;
        playlist.isMaster = true;
        continue;
      }

      // Segment info (media playlist)
      if (line.startsWith('#EXTINF')) {
        currentSegment.duration = this.parseExtinf(line);
        extinfFound = true;
        continue;
      }

      // Segment URL (media playlist)
      if (extinfFound && !line.startsWith('#')) {
        currentSegment.url = this.resolveUrl(line);
        playlist.segments.push({...currentSegment});
        currentSegment = {};
        extinfFound = false;
        continue;
      }

      // Metadata tags
      if (line.startsWith('#EXT-X-TARGETDURATION')) {
        playlist.metadata.targetDuration = parseInt(line.split(':')[1]);
      }
      if (line.startsWith('#EXT-X-MEDIA-SEQUENCE')) {
        playlist.metadata.mediaSequence = parseInt(line.split(':')[1]);
      }
      if (line.startsWith('#EXT-X-VERSION')) {
        playlist.metadata.version = parseInt(line.split(':')[1]);
      }
      
      // Discontinuity - new segment group
      if (line === '#EXT-X-DISCONTINUITY') {
        if (playlist.segments.length > 0) {
          playlist.segments[playlist.segments.length - 1].discontinuity = true;
        }
      }
    }

    return playlist;
  }

  /**
   * Parse EXT-X-STREAM-INF line
   * Example: #EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=720x480,CODECS="avc1.640028,mp4a.40.2"
   */
  parseStreamInf(line) {
    const a = this.parseAttributes(line.replace('#EXT-X-STREAM-INF:', ''));
    return {
      bandwidth: parseInt(a.BANDWIDTH, 10) || 0,
      resolution: a.RESOLUTION || null,
      codecs: a.CODECS || null,
      frameRate: a['FRAME-RATE'] ? parseFloat(a['FRAME-RATE']) : null,
      // Group IDs linking this variant to EXT-X-MEDIA renditions
      audioGroup: a.AUDIO || null
    };
  }

  /**
   * Parse an HLS attribute list, respecting quoted values.
   * A plain split(',') corrupts CODECS="avc1.64001f,mp4a.40.2".
   */
  parseAttributes(str) {
    const attrs = {};
    const re = /([A-Za-z0-9-]+)=("[^"]*"|[^,]*)/g;
    let m;
    while ((m = re.exec(str)) !== null) {
      attrs[m[1]] = m[2].replace(/^"|"$/g, '').trim();
    }
    return attrs;
  }

  /**
   * Find the audio rendition a variant depends on.
   * Returns null when audio is muxed into the video segments (the common
   * case for simple streams), in which case nothing extra is needed.
   */
  selectAudioRendition(playlist, variant) {
    if (!variant || !variant.audioGroup) return null;

    const candidates = playlist.media.filter(
      m => m.type === 'AUDIO' && m.groupId === variant.audioGroup && m.url
    );
    if (!candidates.length) return null;

    // Prefer the default track, then the first one offering the most channels
    return candidates.find(m => m.isDefault)
        || candidates.sort((a, b) =>
             (parseInt(b.channels, 10) || 0) - (parseInt(a.channels, 10) || 0))[0];
  }

  /**
   * Parse EXTINF line
   * Example: #EXTINF:10.000,Title here
   */
  parseExtinf(line) {
    const match = line.match(/#EXTINF:([0-9.]+)/);
    return match ? parseFloat(match[1]) : 0;
  }

  /**
   * Resolve relative URL to absolute
   */
  resolveUrl(url) {
    if (url.startsWith('http')) return url;
    if (url.startsWith('//')) return 'https:' + url;
    if (url.startsWith('/')) {
      const urlObj = new URL(this.baseUrl);
      return `${urlObj.protocol}//${urlObj.host}${url}`;
    }
    // Relative path
    return new URL(url, this.baseUrl).href;
  }

  /**
   * Select best quality variant from master playlist
   */
  selectBestVariant(variants) {
    return variants.sort((a, b) => b.bandwidth - a.bandwidth)[0];
  }
}