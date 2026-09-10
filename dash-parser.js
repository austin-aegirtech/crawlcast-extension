/**
 * DASH (MPD) Manifest Parser — proof of concept.
 *
 * Mirrors M3U8Parser's shape (parse() -> structured object, plus
 * selection helpers) but for MPEG-DASH's XML manifest format instead of
 * HLS's M3U playlist format.
 *
 * DASH addresses segments four different ways, and any Representation may
 * use any one of them:
 *   - SegmentTemplate + $Number$        (implicit count from duration)
 *   - SegmentTemplate + SegmentTimeline (explicit <S t= d= r=> list)
 *   - SegmentList                       (explicit <SegmentURL> list, closest to HLS)
 *   - SegmentBase                       (single file, byte-range via an sidx index)
 *
 * This parser resolves the first three modes fully (parse() output already
 * contains a flat segment list). SegmentBase is intentionally NOT resolved
 * here — reading its segment index requires fetching bytes from the media
 * file itself (the sidx box lives inside it), which is a network operation
 * that belongs in dash-downloader.js, not this text parser. For SegmentBase
 * representations, resolveSegments() returns mode: 'base' plus the raw
 * indexRange/BaseURL info the downloader needs to fetch and parse the index.
 *
 * NOT supported (out of scope for this POC, noted rather than guessed at):
 *   - Live/dynamic manifests requiring periodic re-fetch (@minimumUpdatePeriod)
 *   - DRM-protected content (ContentProtection elements are ignored — if a
 *     Representation is encrypted, its segments will download but won't
 *     decode; this parser does not attempt to work around that)
 *   - Multi-Period manifests are parsed (all periods present in the output),
 *     but the downloader is responsible for deciding how to stitch them
 */

class DashParser {
  constructor() {
    this.baseUrl = '';
  }

  /**
   * @param {string} content - Raw MPD XML text
   * @param {string} baseUrl - URL the manifest was fetched from (for relative BaseURL resolution)
   * @returns {Object} { type, periods: [...] }
   */
  parse(content, baseUrl) {
    this.baseUrl = baseUrl;

    const doc = new DOMParser().parseFromString(content, 'application/xml');
    const parseError = doc.querySelector('parsererror');
    if (parseError) {
      throw new Error('Invalid MPD: XML parse error — ' + parseError.textContent.slice(0, 200));
    }

    const mpd = doc.documentElement;
    if (!mpd || mpd.tagName !== 'MPD') {
      throw new Error('Invalid MPD: missing root <MPD> element');
    }

    const manifest = {
      type: mpd.getAttribute('type') || 'static', // 'static' (VOD) or 'dynamic' (live)
      mediaPresentationDuration: this.parseIsoDuration(mpd.getAttribute('mediaPresentationDuration')),
      periods: []
    };

    // BaseURL resolution chain: MPD -> Period -> AdaptationSet -> Representation.
    // Each level's <BaseURL> (if present) is resolved against its parent's,
    // per the DASH spec. mpdBaseUrl is the root of that chain.
    const mpdBaseUrl = this.resolveBaseUrl(mpd, baseUrl);

    const periodEls = Array.from(mpd.getElementsByTagName('Period'));
    if (!periodEls.length) {
      throw new Error('Invalid MPD: no <Period> elements found');
    }

    periodEls.forEach((periodEl, periodIndex) => {
      const periodBaseUrl = this.resolveBaseUrl(periodEl, mpdBaseUrl);

      // SegmentTemplate/SegmentList/SegmentBase may be declared at Period
      // level and inherited by every AdaptationSet/Representation beneath it
      // unless overridden closer to the Representation.
      const periodTemplate = this.getDirectChild(periodEl, 'SegmentTemplate');
      const periodList = this.getDirectChild(periodEl, 'SegmentList');
      const periodBase = this.getDirectChild(periodEl, 'SegmentBase');

      const period = {
        id: periodEl.getAttribute('id') || `period-${periodIndex}`,
        start: this.parseIsoDuration(periodEl.getAttribute('start')),
        duration: this.parseIsoDuration(periodEl.getAttribute('duration'))
          || manifest.mediaPresentationDuration, // single-period manifests often omit Period@duration
        adaptationSets: []
      };

      const adaptationSetEls = Array.from(periodEl.getElementsByTagName('AdaptationSet'));
      adaptationSetEls.forEach((asEl, asIndex) => {
        const asBaseUrl = this.resolveBaseUrl(asEl, periodBaseUrl);

        const asTemplate = this.getDirectChild(asEl, 'SegmentTemplate') || periodTemplate;
        const asList = this.getDirectChild(asEl, 'SegmentList') || periodList;
        const asBase = this.getDirectChild(asEl, 'SegmentBase') || periodBase;

        const contentType = this.inferContentType(asEl);

        const adaptationSet = {
          id: asEl.getAttribute('id') || `as-${asIndex}`,
          contentType, // 'video' | 'audio' | 'text' | null (unknown — inferred from mimeType/codecs)
          mimeType: asEl.getAttribute('mimeType') || null,
          lang: asEl.getAttribute('lang') || null,
          representations: []
        };

        const repEls = Array.from(asEl.getElementsByTagName('Representation'));
        repEls.forEach((repEl) => {
          const repBaseUrl = this.resolveBaseUrl(repEl, asBaseUrl);
          const repTemplate = this.getDirectChild(repEl, 'SegmentTemplate') || asTemplate;
          const repList = this.getDirectChild(repEl, 'SegmentList') || asList;
          const repBase = this.getDirectChild(repEl, 'SegmentBase') || asBase;

          adaptationSet.representations.push({
            id: repEl.getAttribute('id'),
            bandwidth: parseInt(repEl.getAttribute('bandwidth'), 10) || 0,
            width: parseInt(repEl.getAttribute('width'), 10) || null,
            height: parseInt(repEl.getAttribute('height'), 10) || null,
            codecs: repEl.getAttribute('codecs') || null,
            mimeType: repEl.getAttribute('mimeType') || adaptationSet.mimeType,
            baseUrl: repBaseUrl,
            // Raw addressing info, resolved on demand by resolveSegments() —
            // not every Representation needs its segments resolved (only
            // the ones actually selected for download).
            _template: repTemplate,
            _list: repList,
            _base: repBase
          });
        });

        period.adaptationSets.push(adaptationSet);
      });

      manifest.periods.push(period);
    });

    return manifest;
  }

  // ------------------------------------------------------------------ utils

  /** First direct child with the given tag name (avoids matching nested descendants) */
  getDirectChild(el, tagName) {
    for (const child of el.children) {
      if (child.tagName === tagName) return child;
    }
    return null;
  }

  /** contentType attribute, falling back to inference from mimeType, then codecs */
  inferContentType(asEl) {
    const explicit = asEl.getAttribute('contentType');
    if (explicit) return explicit;

    const mimeType = asEl.getAttribute('mimeType') || '';
    if (mimeType.startsWith('video/')) return 'video';
    if (mimeType.startsWith('audio/')) return 'audio';
    if (mimeType.startsWith('text/') || mimeType.includes('stpp') || mimeType.includes('ttml')) return 'text';

    // No mimeType on the AdaptationSet itself — check first Representation's codecs
    const rep = asEl.getElementsByTagName('Representation')[0];
    const codecs = rep ? rep.getAttribute('codecs') || '' : '';
    if (/^(avc|hev|hvc|vp0?9|av01)/i.test(codecs)) return 'video';
    if (/^(mp4a|ac-?3|ec-?3|opus|vorbis)/i.test(codecs)) return 'audio';

    return null;
  }

  /**
   * Resolve this element's own <BaseURL> (if any) against its parent's
   * already-resolved base. Per DASH spec §5.6, BaseURL is optional at every
   * level; when absent, the parent's base carries through unchanged.
   */
  resolveBaseUrl(el, parentBaseUrl) {
    const baseUrlEl = this.getDirectChild(el, 'BaseURL');
    if (!baseUrlEl || !baseUrlEl.textContent.trim()) return parentBaseUrl;
    return this.resolveUrl(baseUrlEl.textContent.trim(), parentBaseUrl);
  }

  resolveUrl(url, baseUrl) {
    if (/^https?:\/\//i.test(url)) return url;
    if (url.startsWith('//')) return 'https:' + url;
    return new URL(url, baseUrl).href;
  }

  /**
   * ISO 8601 duration ("PT1H2M3.5S") -> seconds. Returns null for absent/unparseable input.
   */
  parseIsoDuration(str) {
    if (!str) return null;
    const m = /^PT(?:([\d.]+)H)?(?:([\d.]+)M)?(?:([\d.]+)S)?$/.exec(str);
    if (!m) return null;
    const hours = parseFloat(m[1] || 0);
    const minutes = parseFloat(m[2] || 0);
    const seconds = parseFloat(m[3] || 0);
    return hours * 3600 + minutes * 60 + seconds;
  }

  // ---------------------------------------------------------- substitution

  /**
   * Substitute $Number$, $Time$, $Bandwidth$, $RepresentationID$, $$ (and
   * their %0Nd-padded forms) into a SegmentTemplate URL pattern.
   */
  substituteTemplate(template, { representationId, number, time, bandwidth }) {
    return template
      .replace(/\$\$/g, '\u0000') // placeholder for literal $ — restored at the end
      .replace(/\$RepresentationID\$/g, representationId)
      .replace(/\$Bandwidth(?:%0(\d+)d)?\$/g, (_, pad) =>
        pad ? String(bandwidth).padStart(parseInt(pad, 10), '0') : String(bandwidth))
      .replace(/\$Number(?:%0(\d+)d)?\$/g, (_, pad) =>
        number == null ? '' : (pad ? String(number).padStart(parseInt(pad, 10), '0') : String(number)))
      .replace(/\$Time(?:%0(\d+)d)?\$/g, (_, pad) =>
        time == null ? '' : (pad ? String(time).padStart(parseInt(pad, 10), '0') : String(time)))
      .replace(/\u0000/g, '$');
  }

  // ------------------------------------------------------ segment resolution

  /**
   * Resolve a Representation's segment list, regardless of which of the 3
   * text-resolvable addressing modes it uses. SegmentBase is returned
   * unresolved (mode: 'base') — see file header.
   *
   * @param {Object} representation - one entry from adaptationSet.representations
   * @param {Object} period - the parsed Period it belongs to (needed for duration fallback)
   * @returns {{mode: 'template'|'list'|'base', initSegment: {url, range?}|null, segments: Array, indexRange?: string, baseUrl?: string}}
   */
  resolveSegments(representation, period) {
    if (representation._template) {
      return this.resolveTemplate(representation, representation._template, period);
    }
    if (representation._list) {
      return this.resolveList(representation, representation._list);
    }
    if (representation._base) {
      return this.resolveBase(representation, representation._base);
    }
    throw new Error(
      `Representation ${representation.id} has no SegmentTemplate, SegmentList, or ` +
      `SegmentBase (and none was inherited from its AdaptationSet or Period) — ` +
      `nothing to download.`
    );
  }

  resolveTemplate(representation, templateEl, period) {
    const media = templateEl.getAttribute('media');
    const initAttr = templateEl.getAttribute('initialization');
    const timescale = parseInt(templateEl.getAttribute('timescale'), 10) || 1;
    const startNumber = templateEl.getAttribute('startNumber') != null
      ? parseInt(templateEl.getAttribute('startNumber'), 10) : 1;
    const explicitDuration = templateEl.getAttribute('duration')
      ? parseInt(templateEl.getAttribute('duration'), 10) : null;

    if (!media) {
      throw new Error(`SegmentTemplate for Representation ${representation.id} has no "media" attribute`);
    }

    const subs = (number, time) => ({
      representationId: representation.id,
      number,
      time,
      bandwidth: representation.bandwidth
    });

    const initSegment = initAttr
      ? { url: this.resolveUrl(this.substituteTemplate(initAttr, subs(null, null)), representation.baseUrl) }
      : null;

    const timelineEl = this.getDirectChild(templateEl, 'SegmentTimeline');

    let segments = [];

    if (timelineEl) {
      // Explicit <S t= d= r=> list — the precise, unambiguous mode.
      // t = start time (in timescale units), d = duration, r = repeat count
      // (segment repeats r additional times at intervals of d; r="-1" means
      // "repeat until the next <S>'s t, or period end for the last <S>").
      let time = 0;
      let number = startNumber;
      const sEls = Array.from(timelineEl.getElementsByTagName('S'));

      sEls.forEach((sEl, i) => {
        const t = sEl.getAttribute('t');
        if (t != null) time = parseInt(t, 10);
        const d = parseInt(sEl.getAttribute('d'), 10);
        let r = sEl.getAttribute('r') != null ? parseInt(sEl.getAttribute('r'), 10) : 0;

        if (r === -1) {
          // Repeat until the next <S>'s start time, or (if this is the last
          // <S>) until the period's duration runs out.
          const nextT = sEls[i + 1] ? parseInt(sEls[i + 1].getAttribute('t'), 10) : null;
          const periodEndTime = period.duration != null ? period.duration * timescale : null;
          const endTime = nextT != null ? nextT : periodEndTime;
          r = endTime != null ? Math.max(0, Math.round((endTime - time) / d) - 1) : 0;
        }

        for (let rep = 0; rep <= r; rep++) {
          segments.push({
            url: this.resolveUrl(this.substituteTemplate(media, subs(number, time)), representation.baseUrl),
            duration: d / timescale,
            time
          });
          time += d;
          number++;
        }
      });
    } else if (explicitDuration) {
      // No timeline — implicit $Number$ sequence. Segment count derived
      // from Period duration / segment duration (VOD-only; a live manifest
      // without a timeline would need @minimumUpdatePeriod polling, which
      // this parser does not implement).
      const segDurationSeconds = explicitDuration / timescale;
      if (period.duration == null) {
        throw new Error(
          `Representation ${representation.id} uses SegmentTemplate with $Number$ but no ` +
          `SegmentTimeline, and neither Period@duration nor MPD@mediaPresentationDuration ` +
          `is present — segment count can't be determined.`
        );
      }
      const count = Math.ceil(period.duration / segDurationSeconds);
      for (let i = 0; i < count; i++) {
        const number = startNumber + i;
        segments.push({
          url: this.resolveUrl(this.substituteTemplate(media, subs(number, null)), representation.baseUrl),
          duration: segDurationSeconds
        });
      }
    } else {
      throw new Error(
        `SegmentTemplate for Representation ${representation.id} has neither a ` +
        `SegmentTimeline nor a duration attribute — can't resolve segment count.`
      );
    }

    return { mode: 'template', initSegment, segments };
  }

  resolveList(representation, listEl) {
    const timescale = parseInt(listEl.getAttribute('timescale'), 10) || 1;
    const initEl = this.getDirectChild(listEl, 'Initialization');
    const initSegment = initEl
      ? {
          url: this.resolveUrl(initEl.getAttribute('sourceURL') || representation.baseUrl, representation.baseUrl),
          range: initEl.getAttribute('range') || null
        }
      : null;

    const segments = Array.from(listEl.getElementsByTagName('SegmentURL')).map((segEl) => ({
      url: this.resolveUrl(segEl.getAttribute('media'), representation.baseUrl),
      range: segEl.getAttribute('mediaRange') || null,
      duration: (parseInt(listEl.getAttribute('duration'), 10) || 0) / timescale
    }));

    return { mode: 'list', initSegment, segments };
  }

  resolveBase(representation, baseEl) {
    // Deliberately unresolved — reading the sidx box requires fetching bytes
    // from the representation's own media file. dash-downloader.js does
    // that fetch+parse; this just hands over what it needs to do so.
    const initEl = this.getDirectChild(baseEl, 'Initialization');
    const indexRangeEl = baseEl.getAttribute('indexRange');
    const representationIndexEl = this.getDirectChild(baseEl, 'RepresentationIndex');

    return {
      mode: 'base',
      baseUrl: representation.baseUrl,
      initSegment: initEl
        ? { url: representation.baseUrl, range: initEl.getAttribute('range') || null }
        : null,
      // Index lives either inline (indexRange on SegmentBase, same file as
      // media) or in a separate file (RepresentationIndex/@sourceURL)
      indexRange: indexRangeEl || null,
      indexUrl: representationIndexEl
        ? this.resolveUrl(representationIndexEl.getAttribute('sourceURL') || representation.baseUrl, representation.baseUrl)
        : representation.baseUrl,
      segments: [] // filled in by the downloader after parsing the sidx box
    };
  }

  // --------------------------------------------------------------- pickers

  /** Best (highest-bandwidth) video Representation across all AdaptationSets in a Period */
  selectBestVideo(period) {
    const videoSets = period.adaptationSets.filter(as => as.contentType === 'video');
    const allReps = videoSets.flatMap(as => as.representations.map(r => ({ as, rep: r })));
    if (!allReps.length) return null;
    return allReps.sort((a, b) => b.rep.bandwidth - a.rep.bandwidth)[0];
  }

  /** Best audio Representation, optionally matching a preferred language */
  selectBestAudio(period, preferredLang) {
    const audioSets = period.adaptationSets.filter(as => as.contentType === 'audio');
    if (!audioSets.length) return null;

    const preferred = preferredLang ? audioSets.filter(as => as.lang === preferredLang) : [];
    const pool = preferred.length ? preferred : audioSets;

    const allReps = pool.flatMap(as => as.representations.map(r => ({ as, rep: r })));
    if (!allReps.length) return null;
    return allReps.sort((a, b) => b.rep.bandwidth - a.rep.bandwidth)[0];
  }
}
