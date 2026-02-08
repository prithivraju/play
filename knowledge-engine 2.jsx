import { useState, useEffect, useRef, useCallback } from "react";

/* ═══════════════════════════════════════════════════════════════════════
   KNOWLEDGE ENGINE v4
   — Choose your reading mode upfront
   — Imagination text → click to generate actual visual
   — Quizzes only in study mode
   ═══════════════════════════════════════════════════════════════════════ */

const MODEL = "claude-sonnet-4-20250514";
const MAX_FILE = 50 * 1024 * 1024;

const C = {
  void: "#060810", bg: "#0A0D14", surface: "#10141D",
  card: "#161B28", cardHover: "#1C2236",
  border: "#1E2538", borderLight: "#2A3350",
  accent: "#E8A838", accentDim: "#C48A2A",
  accentGlow: "rgba(232,168,56,0.12)", accentGlow2: "rgba(232,168,56,0.06)",
  blue: "#5B8DEF", green: "#4ADE80", rose: "#F87171",
  purple: "#A78BFA", teal: "#2DD4BF",
  text: "#E8E5DF", textSoft: "#B8B5AF",
  textMuted: "#7C7A75", textDim: "#4A4845",
};

const ATMOS = [
  { p: "#E8A838", s: "#5B8DEF", o1: "rgba(232,168,56,0.06)", o2: "rgba(91,141,239,0.04)" },
  { p: "#5B8DEF", s: "#A78BFA", o1: "rgba(91,141,239,0.06)", o2: "rgba(167,139,250,0.04)" },
  { p: "#4ADE80", s: "#E8A838", o1: "rgba(74,222,128,0.05)", o2: "rgba(232,168,56,0.03)" },
  { p: "#A78BFA", s: "#F87171", o1: "rgba(167,139,250,0.06)", o2: "rgba(248,113,113,0.03)" },
  { p: "#2DD4BF", s: "#5B8DEF", o1: "rgba(45,212,191,0.05)", o2: "rgba(91,141,239,0.03)" },
  { p: "#F87171", s: "#E8A838", o1: "rgba(248,113,113,0.05)", o2: "rgba(232,168,56,0.04)" },
];

// ── PDF.js ────────────────────────────────────────────────────────────
const loadPdfJs = () =>
  new Promise((res, rej) => {
    if (window.pdfjsLib) return res(window.pdfjsLib);
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
    s.onload = () => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc =
        "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
      res(window.pdfjsLib);
    };
    s.onerror = rej;
    document.head.appendChild(s);
  });

async function extractPdf(file) {
  const lib = await loadPdfJs();
  const buf = await file.arrayBuffer();
  const pdf = await lib.getDocument({ data: buf }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const pg = await pdf.getPage(i);
    const tc = await pg.getTextContent();
    pages.push({ page: i, text: tc.items.map(x => x.str).join(" ") });
  }
  return { totalPages: pdf.numPages, pages };
}

// ── Claude ────────────────────────────────────────────────────────────
async function askClaude(system, user, maxTokens = 4096) {
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
    });
    const d = await r.json();
    return d.content?.map(c => c.text || "").join("\n") || null;
  } catch (e) { console.error("API:", e); return null; }
}

// ── Reading mode configs ──────────────────────────────────────────────
const MODES = {
  casual: {
    id: "casual", label: "Just Read",
    icon: "📖", desc: "Bite-sized chunks with vivid imagery. Pure reading flow, no interruptions.",
    quizzes: false,
  },
  study: {
    id: "study", label: "Study Mode",
    icon: "🧠", desc: "Chunks + recall questions to test understanding as you go.",
    quizzes: true,
  },
  deep: {
    id: "deep", label: "Deep Dive",
    icon: "🔬", desc: "Study mode + explorer. Ask questions anytime, cross-reference freely.",
    quizzes: true,
  },
};

// ── Chunk prompt — adapts to mode ─────────────────────────────────────
function getChunkPrompt(readingMode) {
  const quizInstruction = readingMode === "casual"
    ? `- quiz: Always null. No quizzes in this mode.`
    : `- quiz: For "conceptual" or "factual" chunks, provide a quick recall question: {"question":"...","options":["A","B","C","D"],"correct":0,"hint":"brief hint"}. For "narrative" chunks, set to null.`;

  return `You are an expert knowledge transformer. Break the given page text into small, digestible learning chunks.

RULES:
- Each chunk: 2-4 sentences MAX. Readable in 10-15 seconds.
- Warm, conversational tone — like a brilliant friend explaining over coffee.
- NO bullet points, NO headers, NO markdown. Pure flowing prose.
- Classify each chunk: "narrative" (stories, descriptions), "conceptual" (theories, frameworks), or "factual" (dates, events, data).

For each chunk provide:
- text: The teaching content (2-4 sentences)
- type: "narrative" | "conceptual" | "factual"
- imagination: A vivid 1-2 sentence scene description for visual generation. Describe a VISUAL SCENE — what would a painting of this concept look like? Include colors, lighting, spatial relationships, objects, atmosphere. This will be used to generate an actual image, so be specific about visual elements. Example: "A vast neural network glowing amber against deep blue void, synapses firing in cascading waves of light, each node a miniature galaxy of interconnected ideas."
${quizInstruction}

Return ONLY valid JSON: {"pageTitle":"evocative title","chunks":[...]}`;
}

// ── Chapter Detection ─────────────────────────────────────────────────
function detectChapters(pages) {
  const chapters = [];
  let cur = { title: "Introduction", startPage: 0, pages: [] };
  pages.forEach((p, i) => {
    const isStart = /^(chapter|section|part|unit)\s+\d/i.test(p.text.trim()) ||
      (p.text.trim().length < 100 && i > 0 && i < pages.length - 1 && cur.pages.length > 2);
    if (isStart && cur.pages.length > 0) {
      chapters.push({ ...cur });
      const m = p.text.trim().match(/^(chapter|section|part|unit)\s+\d+[:\s]*(.*)/i);
      cur = { title: m ? m[0].slice(0, 60) : `Section ${chapters.length + 1}`, startPage: i, pages: [p] };
    } else { cur.pages.push(p); }
  });
  if (cur.pages.length > 0) chapters.push(cur);
  if (chapters.length <= 1 && pages.length > 5) {
    const sz = Math.max(3, Math.ceil(pages.length / Math.min(8, Math.ceil(pages.length / 4))));
    const secs = [];
    for (let i = 0; i < pages.length; i += sz)
      secs.push({ title: i === 0 ? "Opening" : `Section ${secs.length + 1}`, startPage: i, pages: pages.slice(i, i + sz) });
    return secs;
  }
  return chapters.length > 0 ? chapters : [{ title: "Document", startPage: 0, pages }];
}

// ── Styles ────────────────────────────────────────────────────────────
const Styles = () => (
  <style>{`
    @import url('https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Geist:wght@300;400;500;600&display=swap');
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    body{overflow:hidden}
    ::-webkit-scrollbar{width:5px}
    ::-webkit-scrollbar-track{background:transparent}
    ::-webkit-scrollbar-thumb{background:${C.border};border-radius:3px}
    ::selection{background:${C.accentGlow};color:${C.accent}}
    :root{--eo:cubic-bezier(0.16,1,0.3,1);--es:cubic-bezier(0.34,1.56,0.64,1);--em:cubic-bezier(0.25,0.1,0.25,1)}
    @keyframes fadeUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}
    @keyframes fadeIn{from{opacity:0}to{opacity:1}}
    @keyframes scaleIn{from{opacity:0;transform:scale(0.95)}to{opacity:1;transform:scale(1)}}
    @keyframes chunkEnter{from{opacity:0;transform:translateY(24px) scale(0.97);filter:blur(3px)}to{opacity:1;transform:translateY(0) scale(1);filter:blur(0)}}
    @keyframes visualReveal{from{opacity:0;transform:scale(0.92);filter:blur(8px)}to{opacity:1;transform:scale(1);filter:blur(0)}}
    @keyframes quizEnter{from{opacity:0;transform:scale(0.93) translateY(16px)}to{opacity:1;transform:scale(1) translateY(0)}}
    @keyframes orbFloat{0%,100%{transform:translate(0,0) scale(1)}33%{transform:translate(30px,-20px) scale(1.05)}66%{transform:translate(-15px,15px) scale(0.97)}}
    @keyframes orbFloat2{0%,100%{transform:translate(0,0)}33%{transform:translate(-25px,25px) scale(0.96)}66%{transform:translate(20px,-10px) scale(1.04)}}
    @keyframes glowPulse{0%,100%{box-shadow:0 0 30px rgba(232,168,56,0.05)}50%{box-shadow:0 0 60px rgba(232,168,56,0.12)}}
    @keyframes breathe{0%,100%{transform:scale(1);opacity:0.5}50%{transform:scale(1.08);opacity:0.8}}
    @keyframes lineGrow{from{transform:scaleX(0)}to{transform:scaleX(1)}}
    @keyframes dotPulse{0%,100%{opacity:0.3;transform:scale(0.8)}50%{opacity:1;transform:scale(1.2)}}
    @keyframes shimmer{from{background-position:-200% 0}to{background-position:200% 0}}
    @keyframes correctPop{0%{transform:scale(1)}50%{transform:scale(1.08)}100%{transform:scale(1)}}
    @keyframes shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-4px)}75%{transform:translateX(4px)}}
    @keyframes genPulse{0%,100%{opacity:0.6;box-shadow:0 0 20px rgba(232,168,56,0.1)}50%{opacity:1;box-shadow:0 0 40px rgba(232,168,56,0.2)}}

    .btn-p{transition:all 0.25s var(--eo);cursor:pointer}
    .btn-p:hover{transform:translateY(-2px);box-shadow:0 6px 24px rgba(232,168,56,0.25)}
    .btn-p:active{transform:translateY(0) scale(0.97)}
    .btn-g{transition:all 0.2s var(--eo);cursor:pointer}
    .btn-g:hover{background:${C.cardHover};transform:translateY(-1px)}
    .btn-g:active{transform:translateY(0) scale(0.98)}
    .upload-zone{transition:all 0.4s var(--es)}
    .upload-zone:hover{border-color:${C.accent};background:${C.accentGlow2};transform:translateY(-3px) scale(1.005);box-shadow:0 20px 60px rgba(0,0,0,0.3),0 0 40px ${C.accentGlow}}
    .upload-zone.drag{border-color:${C.accent};background:${C.accentGlow};transform:scale(1.015)}
    .got-it{transition:all 0.25s var(--eo);cursor:pointer}
    .got-it:hover{transform:translateY(-2px);box-shadow:0 8px 28px rgba(232,168,56,0.3)}
    .got-it:active{transform:translateY(0) scale(0.96)}
    .quiz-opt{transition:all 0.2s var(--eo);cursor:pointer}
    .quiz-opt:hover{border-color:${C.borderLight};background:${C.cardHover};transform:translateX(4px)}
    .quiz-opt.correct{animation:correctPop 0.4s var(--es);border-color:${C.green}60;background:${C.green}12}
    .quiz-opt.wrong{animation:shake 0.3s var(--eo);border-color:${C.rose}50;background:${C.rose}08}
    .chap-item{transition:all 0.2s var(--eo);cursor:pointer}
    .chap-item:hover{background:${C.cardHover}}
    .explore-input:focus{border-color:${C.accent}!important;box-shadow:0 0 0 3px ${C.accentGlow}}
    .dot-pulse span{animation:dotPulse 1.4s infinite}
    .dot-pulse span:nth-child(2){animation-delay:0.2s}
    .dot-pulse span:nth-child(3){animation-delay:0.4s}
    .loading-shimmer{background:linear-gradient(90deg,${C.card} 25%,${C.cardHover} 50%,${C.card} 75%);background-size:200% 100%;animation:shimmer 1.5s infinite}
    .mode-card{transition:all 0.3s var(--eo);cursor:pointer}
    .mode-card:hover{transform:translateY(-4px);box-shadow:0 12px 40px rgba(0,0,0,0.3);border-color:${C.borderLight}}
    .mode-card:active{transform:translateY(-1px) scale(0.99)}
    .mode-card.selected{border-color:${C.accent}50;background:${C.accent}0A;box-shadow:0 0 40px ${C.accentGlow2}}
    .imagine-btn{transition:all 0.3s var(--eo);cursor:pointer}
    .imagine-btn:hover{transform:translateY(-2px);border-color:${C.borderLight};box-shadow:0 8px 30px rgba(0,0,0,0.25)}
    .imagine-btn:active{transform:scale(0.98)}
    .imagine-btn.generating{animation:genPulse 1.5s ease-in-out infinite;pointer-events:none}
  `}</style>
);

// ── Orbs ──────────────────────────────────────────────────────────────
function Orbs({ atm }) {
  const a = atm || ATMOS[0];
  return (
    <div style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: 0, overflow: "hidden" }}>
      <div style={{ position: "absolute", top: "-15%", right: "-10%", width: "70vw", height: "70vw", maxWidth: 900, maxHeight: 900, borderRadius: "50%", background: `radial-gradient(circle,${a.o1} 0%,transparent 70%)`, animation: "orbFloat 25s ease-in-out infinite", filter: "blur(40px)", transition: "background 2s ease" }} />
      <div style={{ position: "absolute", bottom: "-20%", left: "-15%", width: "60vw", height: "60vw", maxWidth: 750, maxHeight: 750, borderRadius: "50%", background: `radial-gradient(circle,${a.o2} 0%,transparent 70%)`, animation: "orbFloat2 30s ease-in-out infinite", filter: "blur(50px)", transition: "background 2s ease" }} />
    </div>
  );
}

// ── Upload Screen ─────────────────────────────────────────────────────
function UploadScreen({ onFile }) {
  const [drag, setDrag] = useState(false);
  const [err, setErr] = useState(null);
  const ref = useRef(null);
  const handle = f => {
    setErr(null);
    if (!f) return;
    if (f.size > MAX_FILE) return setErr("File exceeds 50 MB");
    if (f.type !== "application/pdf") return setErr("Only PDF files");
    onFile(f);
  };
  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "40px 24px", background: C.bg, fontFamily: "'Geist',sans-serif", color: C.text, position: "relative" }}>
      <Orbs atm={ATMOS[0]} />
      <div style={{ position: "relative", zIndex: 1, textAlign: "center", animation: "fadeUp 0.8s var(--eo) both" }}>
        <div style={{ width: 80, height: 80, margin: "0 auto 32px", borderRadius: 22, display: "flex", alignItems: "center", justifyContent: "center", background: `linear-gradient(135deg,${C.accent}14,${C.accent}06)`, border: `1px solid ${C.accent}25`, animation: "glowPulse 4s ease-in-out infinite" }}>
          <svg width="36" height="36" viewBox="0 0 36 36" fill="none"><path d="M18 4L22 14H32L24 20L27 31L18 24L9 31L12 20L4 14H14L18 4Z" stroke={C.accent} strokeWidth="1.5" fill={`${C.accent}15`}/></svg>
        </div>
        <h1 style={{ fontFamily: "'Instrument Serif',serif", fontSize: 52, fontWeight: 400, letterSpacing: "-0.03em", lineHeight: 1.1, marginBottom: 16 }}>Knowledge Engine</h1>
        <p style={{ fontSize: 17, color: C.textSoft, fontWeight: 300, lineHeight: 1.6, maxWidth: 460, margin: "0 auto", animation: "fadeUp 0.8s 0.1s var(--eo) both", opacity: 0 }}>
          Upload any PDF. Choose how you want to read it. See the concepts come alive.
        </p>
      </div>
      <div className={`upload-zone ${drag ? "drag" : ""}`}
        onDragOver={e => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
        onDrop={e => { e.preventDefault(); setDrag(false); handle(e.dataTransfer.files[0]); }}
        onClick={() => ref.current?.click()}
        style={{ position: "relative", zIndex: 1, width: "100%", maxWidth: 520, marginTop: 48, padding: "60px 40px", borderRadius: 24, border: `1.5px dashed ${C.border}`, background: C.surface, cursor: "pointer", textAlign: "center", animation: "fadeUp 0.8s 0.2s var(--eo) both", opacity: 0 }}>
        <svg width="48" height="48" viewBox="0 0 48 48" fill="none" style={{ marginBottom: 16 }}><path d="M24 32V12M24 12L17 19M24 12L31 19" stroke={C.accent} strokeWidth="2" strokeLinecap="round"/><path d="M10 32V36C10 38.2 11.8 40 14 40H34C36.2 40 38 38.2 38 36V32" stroke={C.accent} strokeWidth="2" strokeLinecap="round" opacity="0.5"/></svg>
        <p style={{ fontSize: 17, fontWeight: 500 }}>{drag ? "Release to begin" : "Drop a PDF here"}</p>
        <p style={{ fontSize: 14, color: C.textMuted, marginTop: 8 }}>or click to browse · up to 50 MB</p>
        <input ref={ref} type="file" accept=".pdf" style={{ display: "none" }} onChange={e => handle(e.target.files?.[0])} />
      </div>
      {err && <div style={{ position: "relative", zIndex: 1, marginTop: 16, padding: "10px 20px", borderRadius: 12, background: `${C.rose}12`, color: C.rose, fontSize: 14, animation: "scaleIn 0.3s var(--es)" }}>{err}</div>}
    </div>
  );
}

// ── Mode Selection Screen ─────────────────────────────────────────────
function ModeSelectScreen({ fileName, pageCount, chapterCount, onSelect }) {
  const [selected, setSelected] = useState(null);

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "40px 24px", background: C.bg, fontFamily: "'Geist',sans-serif", color: C.text, position: "relative" }}>
      <Orbs atm={ATMOS[2]} />
      <div style={{ position: "relative", zIndex: 1, textAlign: "center", maxWidth: 600, width: "100%" }}>
        <div style={{ animation: "fadeUp 0.6s var(--eo) both" }}>
          <div style={{ fontSize: 13, color: C.accent, fontWeight: 500, marginBottom: 8, letterSpacing: "0.04em" }}>
            {fileName}
          </div>
          <h2 style={{ fontFamily: "'Instrument Serif',serif", fontSize: 38, fontWeight: 400, letterSpacing: "-0.02em", marginBottom: 6 }}>
            How do you want to read this?
          </h2>
          <p style={{ fontSize: 14, color: C.textMuted, marginBottom: 40 }}>
            {pageCount} pages · {chapterCount} section{chapterCount > 1 ? "s" : ""}
          </p>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {Object.values(MODES).map((m, i) => (
            <div key={m.id}
              className={`mode-card ${selected === m.id ? "selected" : ""}`}
              onClick={() => setSelected(m.id)}
              style={{
                padding: "22px 24px", borderRadius: 18, textAlign: "left",
                background: C.card, border: `1.5px solid ${selected === m.id ? `${C.accent}50` : C.border}`,
                display: "flex", alignItems: "center", gap: 18,
                animation: `fadeUp 0.5s ${0.1 + i * 0.08}s var(--eo) both`, opacity: 0,
              }}>
              <div style={{ fontSize: 32, lineHeight: 1, flexShrink: 0 }}>{m.icon}</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 16, fontWeight: 500, color: C.text, marginBottom: 4 }}>{m.label}</div>
                <div style={{ fontSize: 13, color: C.textMuted, lineHeight: 1.5 }}>{m.desc}</div>
              </div>
              {selected === m.id && (
                <div style={{
                  width: 24, height: 24, borderRadius: "50%",
                  background: C.accent, display: "flex", alignItems: "center", justifyContent: "center",
                  animation: "scaleIn 0.3s var(--es)",
                  flexShrink: 0,
                }}>
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                    <path d="M3.5 7L6 9.5L10.5 4.5" stroke={C.void} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </div>
              )}
            </div>
          ))}
        </div>

        <button className="btn-p" onClick={() => selected && onSelect(selected)}
          disabled={!selected}
          style={{
            marginTop: 32, padding: "14px 40px", borderRadius: 14,
            fontSize: 16, fontWeight: 600,
            background: selected ? C.accent : C.card,
            border: "none", color: selected ? C.void : C.textDim,
            opacity: selected ? 1 : 0.5,
            animation: "fadeUp 0.5s 0.4s var(--eo) both", opacity: 0,
          }}>
          Start reading →
        </button>
      </div>
    </div>
  );
}

// ── Processing Screen ─────────────────────────────────────────────────
function ProcessingScreen({ fileName, progress, label }) {
  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 40, background: C.bg, fontFamily: "'Geist',sans-serif", color: C.text, position: "relative" }}>
      <Orbs atm={ATMOS[1]} />
      <div style={{ position: "relative", zIndex: 1, textAlign: "center" }}>
        <div style={{ width: 88, height: 88, margin: "0 auto 36px", position: "relative" }}>
          <svg width="88" height="88" viewBox="0 0 88 88" style={{ animation: "breathe 3s ease-in-out infinite" }}>
            <circle cx="44" cy="44" r="38" stroke={C.border} strokeWidth="1.5" fill="none" />
            <circle cx="44" cy="44" r="38" stroke={C.accent} strokeWidth="2" fill="none" strokeDasharray={`${progress * 2.39} 239`} strokeLinecap="round" transform="rotate(-90 44 44)" style={{ transition: "stroke-dasharray 0.8s var(--eo)" }} />
          </svg>
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, fontWeight: 300, color: C.accent }}>{Math.round(progress)}%</div>
        </div>
        <h2 style={{ fontFamily: "'Instrument Serif',serif", fontSize: 32, fontWeight: 400, marginBottom: 12 }}>Preparing your journey</h2>
        <p style={{ fontSize: 14, color: C.textMuted, marginBottom: 8 }}>{fileName}</p>
        <p style={{ fontSize: 13, color: C.textDim }}>{label}</p>
      </div>
    </div>
  );
}

// ── Imagination Block (clickable → generates visual) ──────────────────
function ImaginationBlock({ text, atm, pageText }) {
  const [vis, setVis] = useState(null);
  const [generating, setGenerating] = useState(false);

  if (!text) return null;

  const generateVisual = async () => {
    if (generating || vis) return;
    setGenerating(true);
    const r = await askClaude(
      `Generate an SVG illustration that brings this scene to life. Create something IMMERSIVE and ATMOSPHERIC — not a diagram, but an artistic scene visualization.

Style: Dark background (#10141D). Rich, layered visual with depth. Use gradients, soft glows, overlapping shapes to create atmosphere. Colors: primary ${atm.p}, secondary ${atm.s}, plus #5B8DEF, #4ADE80, #A78BFA for variety. Text labels in #E8E5DF. Max 620x400px.

This should feel like a window into another world — evocative, not clinical. Use organic shapes, atmospheric effects (radial gradients for glow/light sources), and layered depth (foreground/midground/background). Think concept art, not flowchart.

Return ONLY raw SVG code. No markdown, no backticks.`,
      `Scene to visualize:\n"${text}"\n\nContext from the page:\n"${(pageText || "").slice(0, 1000)}"\n\nCreate an immersive, atmospheric SVG scene.`
    );
    setGenerating(false);
    if (r) {
      const m = r.match(/<svg[\s\S]*<\/svg>/i);
      if (m) setVis(m[0]);
    }
  };

  return (
    <div style={{ marginTop: 18 }}>
      {/* Clickable imagination prompt */}
      <div className={`imagine-btn ${generating ? "generating" : ""}`}
        onClick={generateVisual}
        style={{
          padding: "16px 20px", borderRadius: 16,
          background: `linear-gradient(135deg, ${atm.p}08, ${atm.s}05)`,
          border: `1px solid ${atm.p}20`,
          display: "flex", alignItems: "flex-start", gap: 14,
          boxShadow: `inset 0 0 40px ${atm.p}03`,
        }}>
        <div style={{ flexShrink: 0, marginTop: 2 }}>
          {generating ? (
            <div style={{ width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <svg width="20" height="20" viewBox="0 0 20 20" style={{ animation: "breathe 1.5s ease-in-out infinite" }}>
                <circle cx="10" cy="10" r="8" stroke={atm.p} strokeWidth="1.5" fill="none" strokeDasharray="16 34" strokeLinecap="round">
                  <animateTransform attributeName="transform" type="rotate" from="0 10 10" to="360 10 10" dur="1s" repeatCount="indefinite"/>
                </circle>
              </svg>
            </div>
          ) : vis ? (
            <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
              <rect x="2" y="2" width="24" height="24" rx="6" stroke={atm.p} strokeWidth="1.5" fill={`${atm.p}10`}/>
              <circle cx="10" cy="11" r="3" stroke={atm.p} strokeWidth="1.2"/>
              <path d="M5 22L10 16L14 19L19 13L23 17" stroke={atm.p} strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          ) : (
            <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
              <circle cx="14" cy="14" r="10" stroke={atm.p} strokeWidth="1.3" fill="none" opacity="0.5"/>
              <circle cx="14" cy="14" r="4" fill={atm.p} opacity="0.3"/>
              <path d="M14 4V7M14 21V24M4 14H7M21 14H24M7 7L9 9M19 19L21 21M21 7L19 9M9 19L7 21" stroke={atm.p} strokeWidth="1" strokeLinecap="round" opacity="0.4"/>
            </svg>
          )}
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.12em", color: atm.p, marginBottom: 6, display: "flex", alignItems: "center", gap: 6 }}>
            {generating ? "Generating visual…" : vis ? "Imagination" : "Imagine this · click to visualize"}
          </div>
          <p style={{ fontSize: 14.5, lineHeight: 1.7, color: C.textSoft, fontFamily: "'Instrument Serif',serif", fontStyle: "italic", fontWeight: 400 }}>
            {text}
          </p>
        </div>
      </div>

      {/* Generated visual */}
      {vis && (
        <div style={{
          marginTop: 12, padding: 20, borderRadius: 16,
          background: `linear-gradient(160deg, ${C.card}, ${C.surface})`,
          border: `1px solid ${atm.p}18`,
          boxShadow: `0 8px 40px rgba(0,0,0,0.3), 0 0 40px ${atm.p}06`,
          animation: "visualReveal 0.8s var(--eo) both",
          overflow: "hidden",
        }}>
          <div dangerouslySetInnerHTML={{ __html: vis }} style={{ width: "100%", display: "flex", justifyContent: "center", overflow: "auto" }} />
        </div>
      )}
    </div>
  );
}

// ── Quiz Block ────────────────────────────────────────────────────────
function QuizBlock({ quiz, atm, onComplete }) {
  const [sel, setSel] = useState(null);
  const [revealed, setRevealed] = useState(false);
  if (!quiz) return null;
  const pick = i => {
    if (revealed) return;
    setSel(i);
    setRevealed(true);
    setTimeout(() => onComplete(i === quiz.correct), 1000);
  };
  return (
    <div style={{ padding: "20px 22px", borderRadius: 16, background: C.card, border: `1px solid ${C.border}`, marginTop: 20, animation: "quizEnter 0.5s var(--es) both" }}>
      <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.12em", color: C.teal, marginBottom: 12, display: "flex", alignItems: "center", gap: 6 }}>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="6" stroke={C.teal} strokeWidth="1.2"/><text x="7" y="10" textAnchor="middle" fill={C.teal} fontSize="8" fontWeight="600">?</text></svg>
        Quick recall
      </div>
      <p style={{ fontSize: 15, lineHeight: 1.6, color: C.text, marginBottom: 14 }}>{quiz.question}</p>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {quiz.options.map((opt, i) => {
          let cls = "quiz-opt";
          if (revealed && i === quiz.correct) cls += " correct";
          else if (revealed && i === sel && i !== quiz.correct) cls += " wrong";
          return (
            <button key={i} className={cls} onClick={() => pick(i)} style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 16px", borderRadius: 12, fontSize: 14, background: "transparent", border: `1px solid ${C.border}`, color: C.textSoft, textAlign: "left", width: "100%", fontFamily: "'Geist',sans-serif" }}>
              <div style={{ width: 24, height: 24, borderRadius: 8, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", border: `1.5px solid ${revealed && i === quiz.correct ? C.green : revealed && i === sel ? C.rose : C.border}`, background: revealed && i === quiz.correct ? `${C.green}12` : revealed && i === sel && i !== quiz.correct ? `${C.rose}08` : "transparent", fontSize: 11, fontWeight: 600, color: revealed && i === quiz.correct ? C.green : revealed && i === sel ? C.rose : C.textDim, transition: "all 0.3s var(--eo)" }}>
                {revealed && i === quiz.correct ? "✓" : revealed && i === sel ? "✗" : String.fromCharCode(65 + i)}
              </div>
              {opt}
            </button>
          );
        })}
      </div>
      {revealed && sel !== quiz.correct && quiz.hint && (
        <div style={{ marginTop: 12, padding: "10px 14px", borderRadius: 10, background: `${C.accent}08`, border: `1px solid ${C.accent}15`, fontSize: 13, color: C.accent, fontStyle: "italic", animation: "fadeUp 0.3s var(--eo)" }}>💡 {quiz.hint}</div>
      )}
    </div>
  );
}

// ── Chunk View ────────────────────────────────────────────────────────
function ChunkView({ chunk, chunkIdx, totalChunks, atm, onGotIt, readingMode, pageText, animKey }) {
  const [quizDone, setQuizDone] = useState(false);
  const showQuiz = readingMode !== "casual" && chunk.quiz && (chunk.type === "conceptual" || chunk.type === "factual");
  const canProceed = showQuiz ? quizDone : true;

  return (
    <div key={animKey} style={{ maxWidth: 580, margin: "0 auto", width: "100%", animation: "chunkEnter 0.6s var(--eo) both" }}>
      {/* Chunk dots */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 22 }}>
        <div style={{ display: "flex", gap: 4 }}>
          {Array.from({ length: totalChunks }, (_, i) => (
            <div key={i} style={{
              width: i === chunkIdx ? 22 : 6, height: 4, borderRadius: 2,
              background: i < chunkIdx ? C.green : i === chunkIdx ? atm.p : C.border,
              transition: "all 0.4s var(--eo)",
              boxShadow: i === chunkIdx ? `0 0 8px ${atm.p}40` : "none",
            }} />
          ))}
        </div>
        <span style={{ fontSize: 11, color: C.textDim, fontWeight: 500 }}>{chunkIdx + 1}/{totalChunks}</span>
      </div>

      {/* Text content */}
      <div style={{ fontSize: 17.5, lineHeight: 1.95, color: C.text, fontWeight: 300, animation: "fadeUp 0.5s 0.05s var(--eo) both", opacity: 0 }}>
        {chunk.text}
      </div>

      {/* Imagination — clickable */}
      <ImaginationBlock text={chunk.imagination} atm={atm} pageText={pageText} />

      {/* Quiz (only in study/deep mode for conceptual/factual) */}
      {showQuiz && !quizDone && (
        <QuizBlock quiz={chunk.quiz} atm={atm} onComplete={() => setQuizDone(true)} />
      )}

      {/* Got it */}
      {canProceed && (
        <div style={{ marginTop: 28, display: "flex", justifyContent: "center", animation: "fadeUp 0.4s 0.2s var(--eo) both", opacity: 0 }}>
          <button className="got-it" onClick={onGotIt} style={{
            padding: "12px 36px", borderRadius: 14, fontSize: 15, fontWeight: 600,
            background: atm.p, border: "none", color: C.void,
            display: "flex", alignItems: "center", gap: 8,
            boxShadow: `0 4px 20px ${atm.p}30`,
          }}>
            {chunkIdx < totalChunks - 1 ? "Got it →" : "Next page →"}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Typing ────────────────────────────────────────────────────────────
function Typing() {
  return (
    <div className="dot-pulse" style={{ display: "inline-flex", gap: 5, padding: "14px 20px", borderRadius: "16px 16px 16px 4px", background: C.card, border: `1px solid ${C.border}` }}>
      {[0, 1, 2].map(i => <span key={i} style={{ width: 7, height: 7, borderRadius: "50%", background: C.accent, display: "block" }} />)}
    </div>
  );
}

// ── Main Learning Interface ───────────────────────────────────────────
function LearningInterface({ pdfData, chapters, processedChapters, fileName, readingMode, onReset, onLoadChapter, loadingChapter }) {
  const [curChap, setCurChap] = useState(0);
  const [curPage, setCurPage] = useState(0);
  const [curChunk, setCurChunk] = useState(0);
  const [mode, setMode] = useState("guided");
  const [chatMsgs, setChatMsgs] = useState([]);
  const [inputVal, setInputVal] = useState("");
  const [loading, setLoading] = useState(false);
  const [animKey, setAnimKey] = useState(0);
  const scrollRef = useRef(null);
  const chatEnd = useRef(null);

  const chapter = chapters[curChap];
  const chapData = processedChapters[curChap];
  const pageChunks = chapData?.[curPage];
  const chunk = pageChunks?.[curChunk];
  const totalPages = chapter?.pages?.length || 0;
  const atm = ATMOS[(curChap + curPage) % ATMOS.length];
  const fullText = pdfData.pages.map(p => p.text).join("\n\n").slice(0, 12000);
  const pageText = chapter?.pages?.[curPage]?.text || "";
  const showExplorer = readingMode === "deep" || mode === "explorer";

  useEffect(() => {
    if (curChap + 1 < chapters.length && !processedChapters[curChap + 1]) onLoadChapter(curChap + 1);
  }, [curChap]);

  useEffect(() => { scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" }); }, [curChunk, curPage, curChap]);
  useEffect(() => { chatEnd.current?.scrollIntoView({ behavior: "smooth" }); }, [chatMsgs, loading]);

  const advance = () => {
    setAnimKey(k => k + 1);
    if (pageChunks && curChunk < pageChunks.length - 1) { setCurChunk(curChunk + 1); return; }
    if (curPage < totalPages - 1) { setCurPage(curPage + 1); setCurChunk(0); return; }
    if (curChap < chapters.length - 1) { setCurChap(curChap + 1); setCurPage(0); setCurChunk(0); setChatMsgs([]); return; }
  };

  const jumpChapter = ci => {
    if (!processedChapters[ci]) onLoadChapter(ci);
    setAnimKey(k => k + 1);
    setCurChap(ci); setCurPage(0); setCurChunk(0); setChatMsgs([]); setMode("guided");
  };

  const askQuestion = async () => {
    if (!inputVal.trim() || loading) return;
    const q = inputVal.trim(); setInputVal("");
    setChatMsgs(p => [...p, { role: "user", text: q }]);
    setLoading(true);
    const r = await askClaude(
      `Answer using the PDF content. Conversational, clear, no bullet points. Flowing prose.`,
      `PDF:\n${fullText}\n\nCurrent page: "${pageText.slice(0, 2000)}"\n\nQ: "${q}"`
    );
    setLoading(false);
    if (r) setChatMsgs(p => [...p, { role: "assistant", text: r }]);
  };

  useEffect(() => {
    const onKey = e => {
      if (e.target.tagName === "INPUT" || mode === "explorer") return;
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); advance(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, curChunk, curPage, curChap, pageChunks]);

  const isLoading = !chapData || loadingChapter === curChap;

  // Progress
  let totalAll = 0, doneAll = 0;
  chapters.forEach((ch, ci) => {
    const pd = processedChapters[ci];
    if (pd) {
      pd.forEach((pg, pi) => {
        totalAll += pg.length;
        if (ci < curChap) doneAll += pg.length;
        else if (ci === curChap) {
          if (pi < curPage) doneAll += pg.length;
          else if (pi === curPage) doneAll += curChunk;
        }
      });
    } else totalAll += ch.pages.length * 3;
  });
  const pct = totalAll > 0 ? Math.round((doneAll / totalAll) * 100) : 0;

  return (
    <div style={{ height: "100vh", display: "flex", background: C.bg, fontFamily: "'Geist',sans-serif", color: C.text, position: "relative", overflow: "hidden" }}>
      <Orbs atm={atm} />

      {/* ── Sidebar ── */}
      <div style={{ width: 232, display: "flex", flexDirection: "column", borderRight: `1px solid ${C.border}40`, background: `${C.surface}E0`, backdropFilter: "blur(8px)", position: "relative", zIndex: 10, flexShrink: 0 }}>
        <div style={{ padding: "14px 14px 10px", borderBottom: `1px solid ${C.border}40` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <div style={{ width: 24, height: 24, borderRadius: 6, background: `${C.accent}12`, border: `1px solid ${C.accent}20`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11 }}>◈</div>
            <span style={{ fontSize: 12, color: C.textSoft, fontWeight: 400 }}>{fileName.length > 20 ? fileName.slice(0, 20) + "…" : fileName}</span>
          </div>
          <div style={{ height: 3, borderRadius: 2, background: C.border, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${pct}%`, background: `linear-gradient(90deg,${atm.p},${atm.s})`, transition: "width 0.6s var(--eo)" }} />
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
            <span style={{ fontSize: 10, color: C.textDim }}>{pct}% read</span>
            <span style={{ fontSize: 10, color: C.textDim, padding: "1px 6px", borderRadius: 4, background: `${C.accent}0A`, border: `1px solid ${C.accent}15`, color: C.accent }}>
              {MODES[readingMode]?.icon} {MODES[readingMode]?.label}
            </span>
          </div>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "6px 0" }}>
          <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.1em", color: C.textDim, padding: "6px 14px" }}>Chapters</div>
          {chapters.map((ch, ci) => {
            const active = ci === curChap;
            const loaded = !!processedChapters[ci];
            const past = ci < curChap;
            return (
              <div key={ci} className="chap-item" onClick={() => jumpChapter(ci)} style={{
                padding: "9px 14px", fontSize: 12, borderLeft: active ? `2px solid ${atm.p}` : "2px solid transparent",
                color: active ? atm.p : past ? C.textSoft : C.textMuted,
                display: "flex", alignItems: "center", gap: 8, background: active ? `${atm.p}08` : "transparent",
              }}>
                <div style={{ width: 16, height: 16, borderRadius: "50%", fontSize: 8, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", border: `1.5px solid ${past ? C.green : active ? atm.p : C.border}`, background: past ? `${C.green}12` : "transparent", color: past ? C.green : "inherit" }}>
                  {past ? "✓" : ci + 1}
                </div>
                <span style={{ lineHeight: 1.3 }}>{ch.title.length > 20 ? ch.title.slice(0, 20) + "…" : ch.title}</span>
                {!loaded && !past && <div style={{ marginLeft: "auto", width: 5, height: 5, borderRadius: "50%", background: C.textDim }} />}
              </div>
            );
          })}
        </div>

        <div style={{ padding: "8px 10px", borderTop: `1px solid ${C.border}40`, display: "flex", flexDirection: "column", gap: 5 }}>
          {readingMode === "deep" && (
            <div style={{ display: "flex", gap: 4 }}>
              {[{ k: "guided", l: "Read" }, { k: "explorer", l: "Ask" }].map(m => (
                <button key={m.k} className="btn-g" onClick={() => { setMode(m.k); setChatMsgs([]); }}
                  style={{ flex: 1, padding: "6px 0", borderRadius: 7, fontSize: 11, fontWeight: 500, border: mode === m.k ? `1px solid ${atm.p}30` : `1px solid ${C.border}`, background: mode === m.k ? `${atm.p}0C` : "transparent", color: mode === m.k ? atm.p : C.textMuted }}>
                  {m.l}
                </button>
              ))}
            </div>
          )}
          <button className="btn-g" onClick={onReset} style={{ padding: "6px 0", borderRadius: 7, fontSize: 11, border: `1px solid ${C.border}`, background: "transparent", color: C.textDim, width: "100%" }}>New PDF</button>
        </div>
      </div>

      {/* ── Main ── */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", position: "relative", zIndex: 1 }}>
        {/* Top */}
        <div style={{ padding: "11px 28px", borderBottom: `1px solid ${C.border}30`, backdropFilter: "blur(16px)", background: `${C.bg}D0`, display: "flex", alignItems: "center", justifyContent: "space-between", zIndex: 5 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ padding: "4px 12px", borderRadius: 100, background: `${atm.p}10`, border: `1px solid ${atm.p}20`, fontSize: 12, fontWeight: 500, color: atm.p }}>
              {chapter?.title || "Loading…"}
            </span>
            {pageChunks && <span style={{ fontSize: 12, color: C.textDim }}>Page {curPage + 1}/{totalPages}</span>}
          </div>
          <span style={{ fontSize: 11, color: C.textDim }}>Space / Enter to continue</span>
        </div>

        {/* Progress */}
        <div style={{ height: 2, background: `${C.border}40` }}>
          <div style={{
            height: "100%",
            width: totalPages > 0 ? `${((curPage + (pageChunks ? (curChunk + 1) / pageChunks.length : 0)) / totalPages) * 100}%` : "0%",
            background: `linear-gradient(90deg,${atm.p},${atm.s})`, transition: "width 0.6s var(--eo)", boxShadow: `0 0 10px ${atm.p}30`,
          }} />
        </div>

        {/* Content */}
        <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: "44px 36px 60px", display: "flex", flexDirection: "column", alignItems: "center" }}>
          {mode === "guided" || mode !== "explorer" ? (
            isLoading ? (
              <div style={{ maxWidth: 500, width: "100%", animation: "fadeIn 0.4s var(--eo)" }}>
                <div className="loading-shimmer" style={{ height: 16, borderRadius: 8, marginBottom: 16, width: "40%" }} />
                <div className="loading-shimmer" style={{ height: 80, borderRadius: 14, marginBottom: 16 }} />
                <div className="loading-shimmer" style={{ height: 60, borderRadius: 14 }} />
                <p style={{ fontSize: 13, color: C.textDim, textAlign: "center", marginTop: 24 }}>Loading chapter…</p>
              </div>
            ) : chunk ? (
              <>
                {curChunk === 0 && (
                  <div style={{ maxWidth: 580, width: "100%", margin: "0 auto 24px", animation: "fadeUp 0.5s var(--eo) both" }}>
                    <h2 style={{ fontFamily: "'Instrument Serif',serif", fontSize: 32, fontWeight: 400, letterSpacing: "-0.02em", lineHeight: 1.15, color: C.text }}>
                      {pageChunks?.pageTitle || `Page ${curPage + 1}`}
                    </h2>
                    <div style={{ height: 1, marginTop: 14, background: `linear-gradient(90deg,${C.border},transparent)`, animation: "lineGrow 0.8s 0.2s var(--eo) both", transformOrigin: "left" }} />
                  </div>
                )}
                <ChunkView
                  chunk={chunk} chunkIdx={curChunk} totalChunks={pageChunks?.length || 0}
                  atm={atm} onGotIt={advance} readingMode={readingMode} pageText={pageText} animKey={animKey}
                />
              </>
            ) : (
              <div style={{ textAlign: "center", padding: 40, animation: "fadeIn 0.4s var(--eo)" }}>
                <div style={{ fontSize: 48, marginBottom: 16 }}>🎉</div>
                <h2 style={{ fontFamily: "'Instrument Serif',serif", fontSize: 28, fontWeight: 400, marginBottom: 8 }}>Journey complete</h2>
                <p style={{ fontSize: 15, color: C.textMuted }}>You've read through the entire document.</p>
              </div>
            )
          ) : (
            <div style={{ maxWidth: 580, width: "100%", margin: "0 auto" }}>
              <div style={{ marginBottom: 28, animation: "fadeUp 0.5s var(--eo)" }}>
                <h2 style={{ fontFamily: "'Instrument Serif',serif", fontSize: 30, fontWeight: 400, marginBottom: 8 }}>Ask anything</h2>
                <p style={{ fontSize: 14, color: C.textMuted, fontWeight: 300 }}>Full document in context.</p>
              </div>
              {chatMsgs.length === 0 && (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 28, animation: "fadeUp 0.5s 0.1s var(--eo) both", opacity: 0 }}>
                  {["Summarize everything so far", "What's the key takeaway?", "Explain like I'm 10", "Real-world applications?"].map((s, i) => (
                    <button key={i} className="btn-g" onClick={() => setInputVal(s)} style={{ padding: "9px 16px", borderRadius: 11, border: `1px solid ${C.border}`, background: C.surface, color: C.textSoft, fontSize: 13, textAlign: "left" }}>{s}</button>
                  ))}
                </div>
              )}
              {chatMsgs.map((m, i) => (
                <div key={i} style={{ display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start", marginBottom: 12, animation: "fadeUp 0.35s var(--eo)" }}>
                  <div style={{ padding: m.role === "user" ? "12px 18px" : "14px 20px", borderRadius: m.role === "user" ? "16px 16px 4px 16px" : "16px 16px 16px 4px", background: m.role === "user" ? `${C.accent}15` : C.card, border: `1px solid ${m.role === "user" ? `${C.accent}25` : C.border}`, fontSize: 15, lineHeight: 1.7, color: m.role === "user" ? C.text : C.textSoft, maxWidth: "85%", whiteSpace: "pre-wrap", fontWeight: 300 }}>{m.text}</div>
                </div>
              ))}
              {loading && <Typing />}
              <div ref={chatEnd} />
            </div>
          )}
        </div>

        {/* Bottom (explorer input) */}
        {mode === "explorer" && (
          <div style={{ padding: "14px 28px", borderTop: `1px solid ${C.border}40`, backdropFilter: "blur(20px)", background: `${C.bg}E8`, zIndex: 5 }}>
            <div style={{ display: "flex", gap: 10, maxWidth: 580, margin: "0 auto" }}>
              <input className="explore-input" value={inputVal} onChange={e => setInputVal(e.target.value)} onKeyDown={e => e.key === "Enter" && !e.shiftKey && askQuestion()} placeholder="Ask anything…"
                style={{ flex: 1, padding: "12px 18px", borderRadius: 14, background: C.card, border: `1.5px solid ${C.border}`, color: C.text, fontSize: 15, outline: "none", fontFamily: "'Geist',sans-serif", transition: "all 0.25s var(--eo)" }} />
              <button className="btn-p" onClick={askQuestion} disabled={loading || !inputVal.trim()}
                style={{ width: 46, height: 46, borderRadius: 13, background: C.accent, border: "none", color: C.void, display: "flex", alignItems: "center", justifyContent: "center", opacity: loading || !inputVal.trim() ? 0.35 : 1 }}>
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M3 9L15 3L9 15L8 10L3 9Z" fill="currentColor"/></svg>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ═══ App Root ═════════════════════════════════════════════════════════
export default function App() {
  const [stage, setStage] = useState("upload"); // upload → modeSelect → processing → learning
  const [fileName, setFileName] = useState("");
  const [pdfData, setPdfData] = useState(null);
  const [chapters, setChapters] = useState([]);
  const [processedChapters, setProcessedChapters] = useState({});
  const [readingMode, setReadingMode] = useState(null);
  const [progress, setProgress] = useState(0);
  const [loadLabel, setLoadLabel] = useState("");
  const [loadingChapter, setLoadingChapter] = useState(-1);

  const processChapter = useCallback(async (ci, chaps, mode) => {
    const ch = chaps[ci];
    if (!ch?.pages) return;
    setLoadingChapter(ci);
    const result = {};
    const batch = 3;
    for (let i = 0; i < ch.pages.length; i += batch) {
      const pages = ch.pages.slice(i, i + batch);
      const text = pages.map((p, bi) => `=== PAGE ${i + bi + 1} (doc page ${p.page}) ===\n${p.text}`).join("\n\n");
      const r = await askClaude(getChunkPrompt(mode || "casual"), `Break these pages into learning chunks:\n\n${text}`);
      if (r) {
        try {
          const cleaned = r.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
          let parsed;
          try { parsed = JSON.parse(cleaned); } catch {
            try { parsed = JSON.parse(`[${cleaned.replace(/\}\s*\{/g, "},{")}]`); } catch { parsed = null; }
          }
          if (parsed) {
            const items = Array.isArray(parsed) ? parsed : [parsed];
            items.forEach((item, idx) => {
              const pi = i + idx;
              if (item.chunks && Array.isArray(item.chunks)) {
                result[pi] = item.chunks;
                result[pi].pageTitle = item.pageTitle || `Page ${pi + 1}`;
              }
            });
          }
        } catch (e) { console.error("Parse:", e); }
      }
      // Fallback
      pages.forEach((p, bi) => {
        const pi = i + bi;
        if (!result[pi]) {
          const sents = p.text.match(/[^.!?]+[.!?]+/g) || [p.text];
          const chunks = [];
          for (let s = 0; s < sents.length; s += 3) chunks.push({ text: sents.slice(s, s + 3).join(" ").trim(), type: "narrative", imagination: null, quiz: null });
          result[pi] = chunks.length > 0 ? chunks : [{ text: p.text.slice(0, 300), type: "narrative", imagination: null, quiz: null }];
          result[pi].pageTitle = `Page ${pi + 1}`;
        }
      });
    }
    const arr = [];
    for (let i = 0; i < ch.pages.length; i++) {
      const d = result[i] || [{ text: ch.pages[i].text.slice(0, 300), type: "narrative", imagination: null, quiz: null }];
      d.pageTitle = result[i]?.pageTitle || `Page ${i + 1}`;
      arr.push(d);
    }
    setProcessedChapters(prev => ({ ...prev, [ci]: arr }));
    setLoadingChapter(-1);
  }, []);

  const handleFile = async (file) => {
    setFileName(file.name);
    setStage("processing");
    setProgress(15); setLoadLabel("Reading PDF…");
    try {
      const pdf = await extractPdf(file);
      setPdfData(pdf);
      setProgress(40); setLoadLabel("Detecting chapters…");
      const chaps = detectChapters(pdf.pages);
      setChapters(chaps);
      setProgress(100); setLoadLabel(`Found ${chaps.length} section${chaps.length > 1 ? "s" : ""}.`);
      setTimeout(() => setStage("modeSelect"), 500);
    } catch (err) {
      console.error(err);
    }
  };

  const handleModeSelect = async (mode) => {
    setReadingMode(mode);
    setStage("processing");
    setProgress(50); setLoadLabel("Preparing first section…");
    await processChapter(0, chapters, mode);
    setProgress(100); setLoadLabel("Ready!");
    setTimeout(() => setStage("learning"), 400);
    if (chapters.length > 1) processChapter(1, chapters, mode);
  };

  const handleLoadChapter = useCallback((ci) => {
    if (processedChapters[ci] || loadingChapter === ci) return;
    processChapter(ci, chapters, readingMode);
  }, [processedChapters, loadingChapter, chapters, readingMode, processChapter]);

  const handleReset = () => {
    setStage("upload"); setFileName(""); setPdfData(null);
    setChapters([]); setProcessedChapters({}); setReadingMode(null); setProgress(0);
  };

  return (
    <>
      <Styles />
      {stage === "upload" && <UploadScreen onFile={handleFile} />}
      {stage === "modeSelect" && <ModeSelectScreen fileName={fileName} pageCount={pdfData?.totalPages || 0} chapterCount={chapters.length} onSelect={handleModeSelect} />}
      {stage === "processing" && <ProcessingScreen fileName={fileName} progress={progress} label={loadLabel} />}
      {stage === "learning" && pdfData && chapters.length > 0 && (
        <LearningInterface pdfData={pdfData} chapters={chapters} processedChapters={processedChapters} fileName={fileName} readingMode={readingMode} onReset={handleReset} onLoadChapter={handleLoadChapter} loadingChapter={loadingChapter} />
      )}
    </>
  );
}
