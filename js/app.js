/* ============================================================
 * Analytics Club Certificate Portal
 * Frontend logic: name matching, certificate rendering, download
 * ============================================================ */

(function () {
  'use strict';

  // ---------- state ----------
  const state = {
    pick: null,        // 'bootcamp' | 'wids'
    query: '',
    exactName: null,   // if set, do exact-name lookup instead of fuzzy
  };

  // ---------- certificate template configuration ----------
  // Each template is 2000x1414. Numbers are in template-pixel space.
  // The name is centered horizontally on `nameCenterX` and the BASELINE
  // sits a few pixels above the underline at `nameBaselineY`.
  // Note: cv-basic and nlp-basic use a slightly different x-center than
  // cv-advanced / nlp-advanced / wids — we measured both.
  const CERT_TEMPLATES = {
    cv_basic: {
      file: 'assets/templates/cv-basic.png',
      title: 'Computer Vision · Basic Track',
      subtitle: 'Deep Learning Bootcamp 2025',
      nameCenterX: 1080,
      nameBaselineY: 645,
      nameMaxWidth: 1000,
      nameFontSize: 70,
    },
    cv_advanced: {
      file: 'assets/templates/cv-advanced.png',
      title: 'Computer Vision · Advanced Track',
      subtitle: 'Deep Learning Bootcamp 2025',
      nameCenterX: 1120,
      nameBaselineY: 645,
      nameMaxWidth: 1000,
      nameFontSize: 70,
    },
    nlp_basic: {
      file: 'assets/templates/nlp-basic.png',
      title: 'Natural Language Processing · Basic Track',
      subtitle: 'Deep Learning Bootcamp 2025',
      nameCenterX: 1080,
      nameBaselineY: 645,
      nameMaxWidth: 1000,
      nameFontSize: 70,
    },
    nlp_advanced: {
      file: 'assets/templates/nlp-advanced.png',
      title: 'Natural Language Processing · Advanced Track',
      subtitle: 'Deep Learning Bootcamp 2025',
      nameCenterX: 1120,
      nameBaselineY: 645,
      nameMaxWidth: 1000,
      nameFontSize: 70,
    },
    wids: {
      file: 'assets/templates/wids.png',
      title: 'Winter in Data Science 2025',
      subtitle: null, // project name shown instead
      nameCenterX: 1121,
      nameBaselineY: 656,        // adjusted: new template has underline at y=673
      nameMaxWidth: 1000,
      nameFontSize: 70,
    },
    mentor: {
      file: 'assets/templates/wids-mentor.png',
      title: 'WiDS 5.0 · Mentor',
      subtitle: null, // project name shown instead
      nameCenterX: 1121,
      nameBaselineY: 656,
      nameMaxWidth: 1000,
      nameFontSize: 70,
    },
  };

  // ---------- name normalization ----------
  function normalize(s) {
    return (s || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '') // strip accents
      .toLowerCase()
      .replace(/[.\-_'"`]+/g, ' ')
      .replace(/[^a-z0-9 ]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function tokenize(s) {
    return normalize(s).split(' ').filter(Boolean);
  }

  // Title-case a name for display on the certificate. Source CSVs have
  // inconsistent casing ("snigdha sahu", "ANUSHKA BHARGAV", "Abhishek kumar")
  // — we always render names with proper title case on the certificate.
  // Rules:
  //   - Single-letter token  → uppercase ("k" → "K"), it's an initial
  //   - Two-letter token, originally all-uppercase → keep uppercase ("BV" → "BV")
  //   - Otherwise → first letter upper, rest lower ("Om" → "Om", "yash" → "Yash")
  //   - Tokens with dots ("A.Purna") → split on dot, apply per-piece, rejoin
  function titleCaseName(name) {
    if (!name) return name;
    const fixWord = (w) => {
      if (!w) return w;
      if (!/[A-Za-z]/.test(w)) return w;
      if (w.indexOf('.') !== -1) {
        return w.split('.').map(fixWord).join('.');
      }
      const letters = w.replace(/[^A-Za-z]/g, '');
      if (!letters) return w;
      if (letters.length === 1) return w.toUpperCase();
      if (letters.length === 2 && letters === letters.toUpperCase()) {
        return w.toUpperCase();
      }
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    };
    return name.split(/\s+/).filter(Boolean).map(fixWord).join(' ');
  }

  // Match types (used for ranking suggestions)
  const MATCH_EXACT = 4;
  const MATCH_TOKEN_SUBSET = 3;   // user tokens are subset of csv tokens (or vice versa)
  const MATCH_FIRST_LAST = 2;     // first + last name match
  const MATCH_FIRST_ONLY = 1;     // only first name matches
  const MATCH_NONE = 0;

  function matchScore(queryTokens, candidateTokens) {
    if (queryTokens.length === 0 || candidateTokens.length === 0) return MATCH_NONE;

    const q = new Set(queryTokens);
    const c = new Set(candidateTokens);
    const qStr = queryTokens.join(' ');
    const cStr = candidateTokens.join(' ');

    if (qStr === cStr) return MATCH_EXACT;

    // If either side is a single token, require exact equality (handled above).
    // Otherwise "abhishek" would falsely match "Abhishek Kumar Yadav".
    if (queryTokens.length === 1 || candidateTokens.length === 1) {
      return MATCH_NONE;
    }

    // Subset match: every query token appears in candidate, or vice versa
    // (handles middle name dropped/added). Both sides have 2+ tokens here.
    const qSubsetOfC = queryTokens.every(t => c.has(t));
    const cSubsetOfQ = candidateTokens.every(t => q.has(t));
    if (qSubsetOfC || cSubsetOfQ) return MATCH_TOKEN_SUBSET;

    // First and last token both match (handles reordered middle names).
    if (
      queryTokens[0] === candidateTokens[0] &&
      queryTokens[queryTokens.length - 1] === candidateTokens[candidateTokens.length - 1]
    ) {
      return MATCH_FIRST_LAST;
    }

    return MATCH_NONE;
  }

  // ---------- bootcamp lookup ----------
  // Returns { needsDisambiguation: bool, candidates: [...], matches: [...] }
  // If multiple distinct people match the query, we ask the user to pick.
  // Otherwise, all eligible track certificates for the matched person.
  function findBootcampMatches(query) {
    const data = window.CERT_DATA.bootcamp;
    const qTokens = tokenize(query);
    const tracks = ['cv_basic', 'cv_advanced', 'nlp_basic', 'nlp_advanced'];
    // For each track, find the best-scoring matched name.
    // Group across tracks by normalized name to detect multiple distinct people.
    const perTrack = []; // [{ track, score, name }]
    for (const track of tracks) {
      let best = { score: MATCH_NONE, name: null };
      for (const csvName of data[track]) {
        const cTokens = tokenize(csvName);
        const score = matchScore(qTokens, cTokens);
        if (score > best.score) best = { score, name: csvName };
      }
      if (best.score >= MATCH_FIRST_LAST) {
        perTrack.push({ trackKey: track, score: best.score, name: best.name });
      }
    }
    if (perTrack.length === 0) {
      return { needsDisambiguation: false, candidates: [], matches: [] };
    }
    // Group by normalized name across tracks
    const byPerson = new Map();
    for (const t of perTrack) {
      const k = normalize(t.name);
      if (!byPerson.has(k)) byPerson.set(k, { displayName: t.name, tracks: [] });
      byPerson.get(k).tracks.push(t.trackKey);
    }
    if (byPerson.size > 1) {
      // Ambiguous: more than one distinct person matched
      return {
        needsDisambiguation: true,
        candidates: Array.from(byPerson.values()).map(p => ({
          displayName: titleCaseName(p.displayName),
          tracks: p.tracks,
        })),
        matches: [],
      };
    }
    // Unique person — return all their tracks
    const person = Array.from(byPerson.values())[0];
    return {
      needsDisambiguation: false,
      candidates: [],
      matches: person.tracks.map(t => ({ trackKey: t, displayName: titleCaseName(person.displayName) })),
    };
  }

  // Once a person is chosen from disambiguation, look up their tracks by exact CSV name.
  function findBootcampForExactName(displayName) {
    const data = window.CERT_DATA.bootcamp;
    const target = normalize(displayName);
    const matches = [];
    for (const track of ['cv_basic', 'cv_advanced', 'nlp_basic', 'nlp_advanced']) {
      for (const n of data[track]) {
        if (normalize(n) === target) {
          matches.push({ trackKey: track, displayName: titleCaseName(n) });
          break;
        }
      }
    }
    return matches;
  }

  // ---------- WiDS lookup ----------
  // Same disambiguation pattern.
  function findWidsMatches(query) {
    const entries = window.CERT_DATA.wids;
    const qTokens = tokenize(query);
    const scored = entries.map(e => ({ entry: e, score: matchScore(qTokens, tokenize(e.name)) }));
    const accepted = scored.filter(s => s.score >= MATCH_FIRST_LAST);
    if (accepted.length === 0) {
      return { needsDisambiguation: false, candidates: [], matches: [] };
    }
    // Group by normalized name
    const byPerson = new Map();
    for (const s of accepted) {
      const k = normalize(s.entry.name);
      if (!byPerson.has(k)) byPerson.set(k, { displayName: s.entry.name, projects: [] });
      byPerson.get(k).projects.push(s.entry.project);
    }
    if (byPerson.size > 1) {
      return {
        needsDisambiguation: true,
        candidates: Array.from(byPerson.values()).map(p => ({
          displayName: titleCaseName(p.displayName),
          extra: `${p.projects.length} project${p.projects.length > 1 ? 's' : ''}`,
        })),
        matches: [],
      };
    }
    const person = Array.from(byPerson.values())[0];
    return {
      needsDisambiguation: false,
      candidates: [],
      matches: person.projects.map(p => ({ displayName: titleCaseName(person.displayName), project: p })),
    };
  }

  function findWidsForExactName(displayName) {
    const target = normalize(displayName);
    return window.CERT_DATA.wids
      .filter(e => normalize(e.name) === target)
      .map(e => ({ displayName: titleCaseName(e.name), project: e.project }));
  }

  // ---------- mentor lookup ----------
  // Same disambiguation pattern as WiDS, against the mentors dataset.
  function findMentorMatches(query) {
    const entries = window.CERT_DATA.mentors || [];
    const qTokens = tokenize(query);
    const scored = entries.map(e => ({ entry: e, score: matchScore(qTokens, tokenize(e.name)) }));
    const accepted = scored.filter(s => s.score >= MATCH_FIRST_LAST);
    if (accepted.length === 0) {
      return { needsDisambiguation: false, candidates: [], matches: [] };
    }
    const byPerson = new Map();
    for (const s of accepted) {
      const k = normalize(s.entry.name);
      if (!byPerson.has(k)) byPerson.set(k, { displayName: s.entry.name, projects: [] });
      byPerson.get(k).projects.push(s.entry.project);
    }
    if (byPerson.size > 1) {
      return {
        needsDisambiguation: true,
        candidates: Array.from(byPerson.values()).map(p => ({
          displayName: titleCaseName(p.displayName),
          extra: `${p.projects.length} project${p.projects.length > 1 ? 's' : ''}`,
        })),
        matches: [],
      };
    }
    const person = Array.from(byPerson.values())[0];
    return {
      needsDisambiguation: false,
      candidates: [],
      matches: person.projects.map(p => ({ displayName: titleCaseName(person.displayName), project: p })),
    };
  }

  function findMentorForExactName(displayName) {
    const entries = window.CERT_DATA.mentors || [];
    const target = normalize(displayName);
    return entries
      .filter(e => normalize(e.name) === target)
      .map(e => ({ displayName: titleCaseName(e.name), project: e.project }));
  }

  // ---------- weak/suggestion lookup ----------
  // For empty results: suggest the closest few names so the user can
  // figure out if they typed something off.
  function findSuggestions(query, scope) {
    const qTokens = tokenize(query);
    if (qTokens.length === 0) return [];

    const candidates = [];
    if (scope === 'bootcamp') {
      const data = window.CERT_DATA.bootcamp;
      const seen = new Set();
      for (const track of ['cv_basic', 'cv_advanced', 'nlp_basic', 'nlp_advanced']) {
        for (const n of data[track]) {
          const key = normalize(n);
          if (!seen.has(key)) {
            seen.add(key);
            candidates.push(n);
          }
        }
      }
    } else if (scope === 'mentor') {
      const seen = new Set();
      for (const e of (window.CERT_DATA.mentors || [])) {
        const key = normalize(e.name);
        if (!seen.has(key)) {
          seen.add(key);
          candidates.push(e.name);
        }
      }
    } else {
      const seen = new Set();
      for (const e of window.CERT_DATA.wids) {
        const key = normalize(e.name);
        if (!seen.has(key)) {
          seen.add(key);
          candidates.push(e.name);
        }
      }
    }

    const scored = candidates.map((n) => {
      const cTokens = tokenize(n);
      // Substring score: how much of qTokens[0] matches start of any cToken
      let score = matchScore(qTokens, cTokens);
      if (score === MATCH_NONE) {
        // weak partial: any candidate token starts with the user's first token
        const first = qTokens[0];
        if (first && cTokens.some(t => t.startsWith(first) || first.startsWith(t))) {
          score = 0.5;
        }
      }
      return { name: n, score };
    });

    return scored
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map(s => titleCaseName(s.name));
  }

  // ---------- canvas certificate rendering ----------
  // Cache loaded template images so re-rendering is instant.
  const imgCache = {};
  function loadTemplate(src) {
    if (imgCache[src]) return Promise.resolve(imgCache[src]);
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => { imgCache[src] = img; resolve(img); };
      img.onerror = reject;
      img.src = src;
    });
  }

  // Fits text to a max width by reducing font size as needed.
  function fitFontSize(ctx, text, fontFamily, weight, startSize, maxWidth) {
    let size = startSize;
    while (size > 14) {
      ctx.font = `${weight} ${size}px ${fontFamily}`;
      const w = ctx.measureText(text).width;
      if (w <= maxWidth) break;
      size -= 2;
    }
    return size;
  }

  function renderCertificate(canvas, templateKey, name, project) {
    const cfg = CERT_TEMPLATES[templateKey];
    return loadTemplate(cfg.file).then((img) => {
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);

      // --- name (centered above underline) ---
      const nameFamily = "'Playfair Display', 'Times New Roman', serif";
      const size = fitFontSize(ctx, name, nameFamily, '700', cfg.nameFontSize, cfg.nameMaxWidth);
      ctx.font = `700 ${size}px ${nameFamily}`;
      ctx.fillStyle = '#0a1f55';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(name, cfg.nameCenterX, cfg.nameBaselineY);

      // --- project (WiDS only): redraw "organised by" line at adjusted position ---
      if (templateKey === 'wids' && project) {
        renderWidsBody(ctx, project);
      } else if (templateKey === 'mentor' && project) {
        renderMentorBody(ctx, project);
      }
    });
  }

  // The WiDS template has 3 sentences in the body:
  //   line A: "has completed the **Winter in Data Science 2025** in"   (baked in, baseline ≈ 747)
  //   line B: <project name> organised by **Analytics Club, IIT Bombay**.   (we draw)
  // Project name flows inline with "organised by..." as one continuous
  // paragraph that wraps naturally — no awkward dedicated "project line".
  // We cover the original template's "organised by..." line and redraw
  // everything fresh. Signatures are also shifted down a bit to leave
  // breathing room above them.
  function renderWidsBody(ctx, project) {
    // The new template has 2 baked body lines:
    //   line A: "has completed the **Winter in Data Science 2025**"     (baseline ≈ 759)
    //   line B: "organised by **Analytics Club, IIT Bombay**."          (baseline ≈ 884)
    // Signatures are already comfortably below (top ≈ 1100), so we only
    // need to white out line B and redraw the project + organised-by inline.
    const LEFT_X         = 585;
    const TEXT_MAX_W     = 1280;   // safe — keeps even worst-case lines within canvas
    const LINE1_BASELINE = 759;    // baseline of "has completed the Winter in Data Science 2025"
    const FONT_SIZE      = 42;
    const FAMILY         = "'Inter', 'Helvetica Neue', Arial, sans-serif";
    const REGULAR        = '500';
    const BOLD           = '700';
    const COLOR          = '#0c1226';

    // 1) Cover the original "organised by..." line so we can redraw inline.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(440, 820, 1500, 90);

    // 2) Build the inline paragraph. Note: line A no longer ends with " in",
    //    so our text starts with "in" to make the sentence read correctly:
    //    "...Winter in Data Science 2025 / in <project> organised by Analytics Club, IIT Bombay."
    //    "Analytics Club, IIT Bombay" is atomic — never splits across lines.
    const atoms = [
      { text: 'in ',                       bold: false, atomic: false },
      { text: project,                     bold: true,  atomic: false },
      { text: ' ',                         bold: false, atomic: false },
      { text: 'organised by ',             bold: false, atomic: false },
      { text: 'Analytics Club, IIT Bombay', bold: true, atomic: true  },
      { text: '.',                         bold: false, atomic: false },
    ];

    const tokens = [];
    for (const a of atoms) {
      if (a.atomic) {
        tokens.push({ text: a.text, bold: a.bold, isSpace: false, atomic: true });
      } else {
        const parts = a.text.split(/(\s+)/);
        for (const p of parts) {
          if (p === '') continue;
          tokens.push({ text: p, bold: a.bold, isSpace: /^\s+$/.test(p), atomic: false });
        }
      }
    }

    ctx.fillStyle = COLOR;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    const setFont = (bold) => {
      ctx.font = `${bold ? BOLD : REGULAR} ${FONT_SIZE}px ${FAMILY}`;
    };

    // Greedy word-wrap into lines.
    const lines = [];
    let cur = [];
    let curW = 0;
    for (const tok of tokens) {
      setFont(tok.bold);
      const w = ctx.measureText(tok.text).width;
      if (curW + w > TEXT_MAX_W && cur.length > 0) {
        while (cur.length && cur[cur.length - 1].isSpace) { cur.pop(); }
        lines.push(cur);
        if (tok.isSpace) { cur = []; curW = 0; continue; }
        cur = [tok];
        curW = w;
      } else {
        cur.push(tok);
        curW += w;
      }
    }
    if (cur.length) {
      while (cur.length && cur[cur.length - 1].isSpace) cur.pop();
      if (cur.length) lines.push(cur);
    }

    // 3) Adaptive line pitch: ideal 70px, shrink if many lines so we still
    //    clear the signature area at y≈1080 with margin.
    const SIG_TOP = 1080;
    const VERT_BUDGET = SIG_TOP - 30 - LINE1_BASELINE;
    const idealPitch = 70;
    const pitch = Math.min(idealPitch, Math.floor(VERT_BUDGET / lines.length));

    let baseline = LINE1_BASELINE + pitch;
    for (const line of lines) {
      let cursorX = LEFT_X;
      for (const tok of line) {
        setFont(tok.bold);
        ctx.fillText(tok.text, cursorX, baseline);
        cursorX += ctx.measureText(tok.text).width;
      }
      baseline += pitch;
    }
  }

  // The MENTOR template body lines (baked in):
  //   Line A (top y=728): "has successfully mentored the project"
  //   SLOT:               <project name>                            [we draw]
  //   Line B (top y=844): "in **Winter in Data Science 2025** organised by"
  //   Line C (top y=904): "**Analytics Club, IIT Bombay.**"
  //
  // Design: render the entire body as one flowing paragraph with natural
  // line-height (56px) — no awkward big gaps before/after the project name.
  // We white out lines B and C and redraw them with project name flowing
  // directly into them, so it reads as one continuous sentence.
  function renderMentorBody(ctx, project) {
    const LEFT_X      = 586;
    const MAX_WIDTH   = 1280;
    const FONT_SIZE   = 44;
    const LINE_HEIGHT = 56;     // natural paragraph leading throughout
    const FAMILY      = "'Inter', 'Helvetica Neue', Arial, sans-serif";
    const BOLD        = '700';
    const REGULAR     = '500';
    const COLOR       = '#0c1226';
    const LINE_A_TOP  = 728;

    // --- 1. Wrap project at 44pt, force into at most 2 lines ---
    ctx.font = `${BOLD} ${FONT_SIZE}px ${FAMILY}`;
    let projLines = greedyWrap(ctx, project, MAX_WIDTH);
    if (projLines.length > 2) {
      const tail = projLines.slice(1).join(' ');
      projLines = [projLines[0], tail];
    }

    // --- 2. Compute positions ---
    // Everything flows with LINE_HEIGHT pitch, like a normal paragraph.
    // Line A is at y=728 (baked). Next line starts one line-height below.
    const projTopY      = LINE_A_TOP + LINE_HEIGHT;                              // 784
    const projLastTopY  = projTopY + (projLines.length - 1) * LINE_HEIGHT;       // 784 or 840
    const lineBTopY     = projLastTopY + LINE_HEIGHT;                            // 840 or 896
    const lineCTopY     = lineBTopY + LINE_HEIGHT;                               // 896 or 952

    // Sanity for 2-line case: line C bottom (952 + 44 ≈ 996) clears sigs (1144) ✓
    // For 1-line: line C bottom (896 + 44 = 940) clears sigs (1144) ✓

    // --- 3. White out original lines B and C ---
    // Originals: B at y=834-880, C at y=894-950. Also need to clear wherever
    // our redrawn lines land if they shift. Never touches signatures (start at 1144).
    const wipeTop    = 770;   // just below line A (which ends ~y=767)
    const wipeBottom = Math.min(1140, lineCTopY + FONT_SIZE + 8);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(440, wipeTop, 1500, wipeBottom - wipeTop);

    // --- 4. Draw project line(s) ---
    ctx.fillStyle = COLOR;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.font = `${BOLD} ${FONT_SIZE}px ${FAMILY}`;
    for (let i = 0; i < projLines.length; i++) {
      ctx.fillText(projLines[i], LEFT_X, projTopY + i * LINE_HEIGHT);
    }

    // --- 5. Redraw line B: "in **Winter in Data Science 2025** organised by" ---
    const runsB = [
      { text: 'in ',                          bold: false },
      { text: 'Winter in Data Science 2025',  bold: true  },
      { text: ' organised by',                bold: false },
    ];
    let cx = LEFT_X;
    for (const run of runsB) {
      ctx.font = `${run.bold ? BOLD : REGULAR} ${FONT_SIZE}px ${FAMILY}`;
      ctx.fillText(run.text, cx, lineBTopY);
      cx += ctx.measureText(run.text).width;
    }

    // --- 6. Redraw line C: "Analytics Club, IIT Bombay." ---
    ctx.font = `${BOLD} ${FONT_SIZE}px ${FAMILY}`;
    ctx.fillText('Analytics Club, IIT Bombay.', LEFT_X, lineCTopY);
  }

  function greedyWrap(ctx, text, maxWidth) {
    const words = text.split(/\s+/).filter(Boolean);
    const lines = [];
    let cur = '';
    for (const w of words) {
      const test = cur ? cur + ' ' + w : w;
      if (ctx.measureText(test).width > maxWidth && cur) {
        lines.push(cur);
        cur = w;
      } else {
        cur = test;
      }
    }
    if (cur) lines.push(cur);
    return lines;
  }

  // ---------- DOM helpers ----------
  function $(sel) { return document.querySelector(sel); }
  function $$(sel) { return Array.from(document.querySelectorAll(sel)); }

  function showStep(id) {
    $$('.step').forEach(el => el.classList.remove('active'));
    $('#' + id).classList.add('active');
    // Compact the hero on non-landing steps so the focus is on the form/results.
    if (id === 'step-pick') {
      document.body.classList.remove('compact-hero');
    } else {
      document.body.classList.add('compact-hero');
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ---------- step 1: pick ----------
  $$('.pick-card').forEach((card) => {
    card.addEventListener('click', () => {
      state.pick = card.dataset.pick;
      configureEnterStep();
      showStep('step-enter');
      setTimeout(() => $('#name-input').focus(), 200);
    });
  });

  // ---------- brand logo → home ----------
  const brandHome = $('#brand-home');
  if (brandHome) {
    brandHome.addEventListener('click', (e) => {
      e.preventDefault();
      state.exactName = null;
      state.query = '';
      if ($('#name-input')) $('#name-input').value = '';
      showStep('step-pick');
    });
  }

  function configureEnterStep() {
    const title = $('#enter-title');
    const sub = $('#enter-sub');
    if (state.pick === 'bootcamp') {
      title.textContent = 'Enter your name';
      sub.textContent = 'Type your full name as you registered for the Deep Learning Bootcamp. We\'ll check all four tracks (CV/NLP × Basic/Advanced) and show every certificate you\'re eligible for.';
    } else if (state.pick === 'mentor') {
      title.textContent = 'Enter your name';
      sub.textContent = 'Type your full name as you registered as a WiDS 5.0 mentor. If you mentored multiple projects, you\'ll see one certificate for each.';
    } else {
      title.textContent = 'Enter your name';
      sub.textContent = 'Type your full name as you registered for WiDS. If you completed multiple projects, you\'ll see one certificate for each.';
    }
  }

  // ---------- step 2: name form ----------
  $('#name-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('#name-input').value.trim();
    if (!q) return;
    state.query = q;
    state.exactName = null;  // fresh search — clear any previous disambiguation lock
    runLookup();
  });

  function runLookup() {
    const list = $('#results-list');
    const empty = $('#results-empty');
    const sub = $('#results-sub');
    const title = $('#results-title');
    list.innerHTML = '';

    let result;
    if (state.exactName) {
      // Exact-name path: skip disambiguation, look up only this name.
      let matches;
      if (state.pick === 'bootcamp') {
        matches = findBootcampForExactName(state.exactName);
      } else if (state.pick === 'mentor') {
        matches = findMentorForExactName(state.exactName);
      } else {
        matches = findWidsForExactName(state.exactName);
      }
      result = { needsDisambiguation: false, candidates: [], matches };
    } else if (state.pick === 'bootcamp') {
      result = findBootcampMatches(state.query);
    } else if (state.pick === 'mentor') {
      result = findMentorMatches(state.query);
    } else {
      result = findWidsMatches(state.query);
    }

    // No match at all
    if (!result.needsDisambiguation && result.matches.length === 0) {
      empty.classList.remove('hidden');
      const suggestions = findSuggestions(state.query, state.pick);
      let suggestHTML = '';
      if (suggestions.length > 0) {
        suggestHTML = '<div style="margin-top:18px"><strong>Did you mean:</strong><div class="suggest-list" style="margin-top:10px">' +
          suggestions.map(n => `<button class="suggest-item" data-name="${escapeHtml(n)}">${escapeHtml(n)}</button>`).join('') +
          '</div></div>';
      }
      empty.innerHTML = `
        <h3>We couldn't find a match</h3>
        <p>Double-check your spelling. If you believe this is an error, please reach out to the Analytics Club team at <a href="mailto:analyticsclub@iitb.ac.in">analyticsclub@iitb.ac.in</a>.</p>
        ${suggestHTML}
      `;
      empty.querySelectorAll('.suggest-item').forEach(btn => {
        btn.addEventListener('click', () => {
          state.query = btn.dataset.name;
          state.exactName = null; // it's a suggestion, run fuzzy again
          $('#name-input').value = btn.dataset.name;
          runLookup();
        });
      });
      title.textContent = 'No certificates found';
      sub.textContent = `We searched for "${state.query}".`;
      showStep('step-results');
      return;
    }

    // Disambiguation needed: multiple distinct people matched
    if (result.needsDisambiguation) {
      empty.classList.remove('hidden');
      empty.innerHTML = `
        <h3>More than one person matches</h3>
        <p>We found <strong>${result.candidates.length}</strong> different people matching "${escapeHtml(state.query)}". Please pick yours:</p>
        <div class="suggest-list" style="margin-top:14px">
          ${result.candidates.map(c =>
            `<button class="suggest-item" data-name="${escapeHtml(c.displayName)}">${escapeHtml(c.displayName)}${c.extra ? ` <span style="color:var(--c-text-muted)">· ${escapeHtml(c.extra)}</span>` : ''}</button>`
          ).join('')}
        </div>
      `;
      empty.querySelectorAll('.suggest-item').forEach(btn => {
        btn.addEventListener('click', () => {
          state.exactName = btn.dataset.name;
          state.query = btn.dataset.name;
          $('#name-input').value = btn.dataset.name;
          runLookup();
        });
      });
      title.textContent = 'Which one are you?';
      sub.textContent = `We searched for "${state.query}".`;
      showStep('step-results');
      return;
    }

    // Success: show certificates
    empty.classList.add('hidden');
    const matches = result.matches;
    title.textContent = 'Your certificates';
    if (state.pick === 'bootcamp') {
      const trackText = matches.length === 1 ? 'one certificate' : `${matches.length} certificates`;
      sub.textContent = `Found ${trackText} for ${matches[0].displayName}. Each is rendered below — click download to save the PDF.`;
    } else if (state.pick === 'mentor') {
      const projText = matches.length === 1 ? '1 project' : `${matches.length} projects`;
      sub.textContent = `Found ${projText} mentored by ${matches[0].displayName}. Each project gets its own mentor certificate.`;
    } else {
      const projText = matches.length === 1 ? '1 project' : `${matches.length} projects`;
      sub.textContent = `Found ${projText} for ${matches[0].displayName}. Each project gets its own personalised certificate.`;
    }

    matches.forEach((m, idx) => {
      if (state.pick === 'bootcamp') {
        list.appendChild(buildBootcampCard(m, idx));
      } else if (state.pick === 'mentor') {
        list.appendChild(buildMentorCard(m, idx));
      } else {
        list.appendChild(buildWidsCard(m, idx));
      }
    });

    showStep('step-results');
  }

  function buildBootcampCard(match, idx) {
    const cfg = CERT_TEMPLATES[match.trackKey];
    const card = document.createElement('div');
    card.className = 'cert-card';
    card.innerHTML = `
      <div class="cert-card-head">
        <div class="cert-meta">
          <span class="cert-tag bootcamp">Bootcamp</span>
          <h3>${escapeHtml(cfg.title)}</h3>
          <p class="cert-name">Awarded to <strong>${escapeHtml(match.displayName)}</strong></p>
        </div>
      </div>
      <div class="cert-preview-wrap">
        <canvas></canvas>
        <div class="cert-loading">Generating certificate…</div>
      </div>
      <button class="download-btn" type="button">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        Download PDF
      </button>
    `;
    const canvas = card.querySelector('canvas');
    const loading = card.querySelector('.cert-loading');
    const dlBtn = card.querySelector('.download-btn');

    renderCertificate(canvas, match.trackKey, match.displayName, null)
      .then(() => loading.classList.add('hidden'))
      .catch(() => { loading.textContent = 'Failed to load template.'; });

    dlBtn.addEventListener('click', () => {
      const fileBase = `${slug(match.displayName)}_${match.trackKey}`;
      downloadCanvasAsPdf(canvas, fileBase);
    });

    return card;
  }

  function buildMentorCard(match, idx) {
    const card = document.createElement('div');
    card.className = 'cert-card';
    card.innerHTML = `
      <div class="cert-card-head">
        <div class="cert-meta">
          <span class="cert-tag mentor">WiDS Mentor</span>
          <h3>${escapeHtml(match.project)}</h3>
          <p class="cert-name">Awarded to <strong>${escapeHtml(match.displayName)}</strong></p>
        </div>
      </div>
      <div class="cert-preview-wrap">
        <canvas></canvas>
        <div class="cert-loading">Generating certificate…</div>
      </div>
      <button class="download-btn" type="button">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        Download PDF
      </button>
    `;
    const canvas = card.querySelector('canvas');
    const loading = card.querySelector('.cert-loading');
    const dlBtn = card.querySelector('.download-btn');

    renderCertificate(canvas, 'mentor', match.displayName, match.project)
      .then(() => loading.classList.add('hidden'))
      .catch(() => { loading.textContent = 'Failed to load template.'; });

    dlBtn.addEventListener('click', () => {
      const fileBase = `${slug(match.displayName)}_WiDS_Mentor_${slug(match.project)}`;
      downloadCanvasAsPdf(canvas, fileBase);
    });

    return card;
  }

  function buildWidsCard(match, idx) {
    const card = document.createElement('div');
    card.className = 'cert-card';
    card.innerHTML = `
      <div class="cert-card-head">
        <div class="cert-meta">
          <span class="cert-tag wids">WiDS Project</span>
          <h3>${escapeHtml(match.project)}</h3>
          <p class="cert-name">Awarded to <strong>${escapeHtml(match.displayName)}</strong></p>
        </div>
      </div>
      <div class="cert-preview-wrap">
        <canvas></canvas>
        <div class="cert-loading">Generating certificate…</div>
      </div>
      <button class="download-btn" type="button">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        Download PDF
      </button>
    `;
    const canvas = card.querySelector('canvas');
    const loading = card.querySelector('.cert-loading');
    const dlBtn = card.querySelector('.download-btn');

    renderCertificate(canvas, 'wids', match.displayName, match.project)
      .then(() => loading.classList.add('hidden'))
      .catch(() => { loading.textContent = 'Failed to load template.'; });

    dlBtn.addEventListener('click', () => {
      const fileBase = `${slug(match.displayName)}_WiDS_${slug(match.project)}`;
      downloadCanvasAsPdf(canvas, fileBase);
    });

    return card;
  }

  // Render the canvas as a single-page A4-landscape PDF and trigger download.
  // The canvas is 2000x1414 (already A4-landscape ratio at ~242dpi), so we
  // embed it as a JPEG (compresses far better than PNG for photo-like content)
  // into a 297x210mm PDF page, edge-to-edge.
  function downloadCanvasAsPdf(canvas, baseName) {
    if (!window.jspdf || !window.jspdf.jsPDF) {
      console.error('jsPDF not loaded');
      // Fallback: PNG download so the user still gets something
      canvas.toBlob((blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${baseName}.png`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }, 'image/png');
      return;
    }
    const { jsPDF } = window.jspdf;
    // A4 landscape: 297 x 210 mm. Our canvas aspect (2000/1414 ≈ 1.414) is
    // close to A4 landscape (297/210 ≈ 1.414) — they match exactly.
    const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
    pdf.addImage(dataUrl, 'JPEG', 0, 0, 297, 210, undefined, 'FAST');
    pdf.save(`${baseName}.pdf`);
  }

  // ---------- back buttons ----------
  $$('[data-back]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.exactName = null;
      showStep(btn.dataset.back);
    });
  });

  // ---------- utils ----------
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  function slug(s) {
    return normalize(s).replace(/\s+/g, '_').slice(0, 60) || 'certificate';
  }

  // ---------- ensure fonts are loaded before any render ----------
  // Otherwise the first render uses a fallback font.
  if (document.fonts && document.fonts.load) {
    Promise.all([
      document.fonts.load('700 70px "Playfair Display"'),
      document.fonts.load('700 44px "Inter"'),
      document.fonts.load('500 44px "Inter"'),
    ]).catch(() => {});
  }
})();
