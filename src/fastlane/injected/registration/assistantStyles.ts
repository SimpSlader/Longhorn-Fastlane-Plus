/** Self-contained styles for the shadow-root assistant (light + dark, UT Registration Plus palette). */
export const ASSISTANT_CSS = `
:host { all: initial; }
*, *::before, *::after { box-sizing: border-box; }
.fl {
  --bg: #ffffff; --surface: #f7f6f3; --text: #1c1917; --muted: #5f5a55; --border: #e2ded6;
  --accent: #bf5700; --accent-ink: #ffffff; --ok: #15803d; --ok-bg: #e8f6ec; --warn: #b45309; --warn-bg: #fdf3e2;
  --bad: #b91c1c; --bad-bg: #fdecec; --info: #1d4ed8; --info-bg: #e8f0ff; --shadow: 0 12px 32px rgba(0,0,0,.18);
  font: 13px/1.45 "Roboto Flex", system-ui, -apple-system, "Segoe UI", sans-serif;
  color: var(--text); background: color-mix(in srgb, var(--bg) 78%, transparent); backdrop-filter: blur(24px) saturate(160%); -webkit-backdrop-filter: blur(24px) saturate(160%); border: 1px solid var(--border); border-radius: 20px;
  width: 280px; max-width: calc(100vw - 24px); max-height: calc(100vh - 24px); overflow: auto; box-shadow: var(--shadow);
}
.fl[data-theme="dark"] {
  --bg: #1f1f23; --surface: #26262b; --text: #f4f4f5; --muted: #a1a1aa; --border: #2e2e33;
  --ok-bg: #0f2a19; --warn-bg: #2d1f08; --bad-bg: #2f1111; --info-bg: #13203f; --shadow: 0 12px 32px rgba(0,0,0,.6);
}
@media (prefers-color-scheme: dark) { .fl[data-theme="system"] {
  --bg: #1f1f23; --surface: #26262b; --text: #f4f4f5; --muted: #a1a1aa; --border: #2e2e33;
  --ok-bg: #0f2a19; --warn-bg: #2d1f08; --bad-bg: #2f1111; --info-bg: #13203f; --shadow: 0 12px 32px rgba(0,0,0,.6);
} }
.head { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:10px 12px; background: transparent; border-bottom:1px solid var(--border); border-radius: 14px 14px 0 0; }
.brand { font-weight: 750; letter-spacing: -.2px; }
.brand small { display:block; font-weight: 500; color: var(--muted); font-size: 10.5px; }
.body { padding: 12px; display:flex; flex-direction:column; gap:8px; }
.eyebrow { font-size: 10px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
.code { font: 700 30px/1 "Roboto Mono", ui-monospace, monospace; letter-spacing: 2px; color: var(--text); user-select: all; }
.course { font-weight: 650; }
.req { font-size: 11.5px; color: var(--muted); }
button { font: inherit; cursor: pointer; border-radius: 10px; transition: border-color 120ms ease-out, filter 120ms ease-out, background 120ms ease-out; border: 1px solid var(--border); background: var(--bg); color: var(--text); padding: 7px 9px; }
button:hover:not(:disabled) { border-color: var(--accent); }
button:focus-visible, select:focus-visible { outline: 2px solid #3b82f6; outline-offset: 2px; }
button:disabled { opacity: .5; cursor: default; }
.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); font-weight: 700; width: 100%; padding: 9px; }
.primary:hover:not(:disabled) { filter: brightness(1.08); }
.row { display:flex; gap:6px; flex-wrap: wrap; }
.grid { display:grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.ok { background: var(--ok-bg); color: var(--ok); border-color: transparent; font-weight: 650; }
.full { background: var(--bad-bg); color: var(--bad); border-color: transparent; font-weight: 650; }
.warn { background: var(--warn-bg); color: var(--warn); border-color: transparent; font-weight: 650; }
.mini { padding: 3px 7px; font-size: 11.5px; border-radius: 6px; }
.ghost { background: transparent; border-color: transparent; color: var(--muted); }
.note { font-size: 11.5px; color: var(--muted); }
.notice { font-size: 12px; border-radius: 8px; padding: 7px 9px; background: var(--surface); border: 1px solid var(--border); }
.notice.info { background: var(--info-bg); border-color: transparent; }
.notice.warn { background: var(--warn-bg); border-color: transparent; color: var(--text); }
.fallback { display:flex; justify-content: space-between; align-items: baseline; gap: 8px; font-size: 12px; padding: 7px 9px; border:1px dashed var(--border); border-radius: 8px; }
.mono { font-family: "Roboto Mono", ui-monospace, monospace; font-weight: 700; }
.section { border-top: 1px solid var(--border); padding-top: 10px; display:flex; flex-direction:column; gap:6px; }
.hist { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:3px; font-size: 11.5px; }
.hist li { display:flex; justify-content: space-between; gap: 6px; color: var(--muted); }
.hist b { color: var(--text); font-weight: 600; }
.rec { border:1px solid var(--border); border-radius: 8px; padding: 7px 8px; display:flex; flex-direction:column; gap:3px; }
.rec .top { display:flex; justify-content: space-between; align-items: center; gap: 6px; }
.badge { display:inline-block; font-size: 10px; font-weight: 700; border-radius: 4px; padding: 1px 5px; background: var(--surface); color: var(--muted); }
.badge.async { background: #1d4ed8; color: #fff; }
.badge.open { background: var(--ok-bg); color: var(--ok); }
.toggle input { appearance:none; -webkit-appearance:none; width:36px; height:22px; border:0; border-radius:99px; background:#d3d0cb; position:relative; cursor:pointer; transition:background .15s; }
.toggle input::after { content:''; position:absolute; top:3px; left:3px; width:16px; height:16px; border-radius:50%; background:#fff; box-shadow:0 1px 3px #0002; transition:transform .15s; }
.toggle input:checked { background:var(--accent); }
.toggle input:checked::after { transform:translateX(14px); }
.toggle input:focus-visible { outline:2px solid var(--accent); outline-offset:3px; }
.fl { box-shadow: 0 16px 48px #482d171c, inset 0 1px 0 #ffffffb3; border-color: #ffffff99; }
.fallback { border-style:solid; background:color-mix(in srgb, var(--bg) 45%, transparent); }
.notice { font-size:11px; padding:5px 7px; }
label.toggle { justify-content:space-between; display:flex; align-items:center; gap:7px; font-size: 12px; cursor: pointer; }
.pill { display:flex; align-items:center; gap:8px; padding: 8px 12px; border-radius: 999px; }
.sr { position:absolute; left:-9999px; }
`;
