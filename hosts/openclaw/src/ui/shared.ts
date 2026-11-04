import type { FeatureClient } from 'openclaw/plugin-sdk/feature-contract';
import type { contract } from '../contract.js';
export type UiClient = FeatureClient<typeof contract>;

export function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
export function button(label: string, action: () => void, className = ''): HTMLButtonElement {
  const node = element('button', `vsc-button ${className}`, label);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}
export function field(label: string, input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): HTMLLabelElement {
  const wrap = element('label', 'vsc-field');
  wrap.append(element('span', '', label), input);
  return wrap;
}
export function input(name: string, value = '', maxLength = 160): HTMLInputElement {
  const node = element('input');
  node.name = name;
  node.value = value;
  node.maxLength = maxLength;
  return node;
}
export function select(name: string, values: { value: string; label: string }[], value = ''): HTMLSelectElement {
  const node = element('select');
  node.name = name;
  for (const option of values) {
    const item = element('option', '', option.label);
    item.value = option.value;
    node.append(item);
  }
  node.value = value;
  return node;
}
export function detail(list: HTMLDListElement, label: string, value: string): void {
  list.append(element('dt', '', label), element('dd', '', value));
}
export function time(at: number): string {
  return Number.isFinite(at) ? new Date(at).toLocaleString() : 'Unknown';
}
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
export function installRoot(container: HTMLElement, label: string): HTMLElement {
  const root = element('section', 'vsc');
  root.setAttribute('aria-label', label);
  const style = element('style');
  style.textContent = styles;
  container.replaceChildren(root);
  root.append(style);
  return root;
}

const styles = `
.vsc{--vsc-bg:var(--bg,#f8fafc);--vsc-panel:var(--bg-elevated,var(--card,var(--bg,#f8fafc)));--vsc-text:var(--text,#172033);--vsc-muted:var(--muted,#596579);--vsc-border:var(--border,#cbd5e1);--vsc-accent:var(--accent,#4263eb);--vsc-warn:var(--warn,#ad5b12);--vsc-danger:var(--danger,#b42318);color:var(--vsc-text);background:var(--vsc-bg);font-family:inherit;font-size:14px;line-height:1.5;min-width:0;display:flex;flex-direction:column;min-height:560px;height:100%;isolation:isolate}
.vsc *{box-sizing:border-box}.vsc h1,.vsc h2,.vsc h3,.vsc p{margin:0}.vsc h1{font-size:18px;line-height:1.3;font-weight:650;letter-spacing:-.025em}.vsc h2{font-size:17px;font-weight:650;letter-spacing:-.02em}.vsc h3{font-size:14px;font-weight:650}.vsc :focus-visible{outline:2px solid var(--vsc-accent);outline-offset:3px}.vsc [hidden]{display:none!important}
.vsc .vsc-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;padding:16px 20px;border-bottom:1px solid var(--vsc-border)}.vsc .vsc-toolbar-title{margin-right:auto;display:flex;align-items:baseline;gap:14px;flex-wrap:wrap}.vsc .vsc-toolbar-actions{display:flex;gap:6px;align-items:center;flex-wrap:wrap}.vsc .vsc-button{font:inherit;color:inherit;background:transparent;border:1px solid var(--vsc-border);border-radius:7px;padding:6px 11px;cursor:pointer;min-height:34px}.vsc .vsc-button:hover{background:color-mix(in srgb,var(--vsc-accent) 8%,transparent)}.vsc .vsc-button:disabled{cursor:wait;opacity:.55}.vsc .vsc-primary{background:var(--vsc-accent);border-color:var(--vsc-accent);color:var(--accent-contrast,#fff)}.vsc .vsc-subtle{color:var(--vsc-muted);font-size:12px}.vsc .vsc-health{font-size:12px;display:flex;gap:7px;align-items:center;color:var(--vsc-muted)}.vsc .vsc-health::before{content:'';width:7px;height:7px;border-radius:50%;background:currentColor}.vsc .vsc-health[data-state=live]{color:var(--vsc-accent)}.vsc .vsc-health[data-state=stale],.vsc .vsc-health[data-state=partial]{color:var(--vsc-warn)}.vsc .vsc-health[data-state=disconnected]{color:var(--vsc-danger)}
.vsc .vsc-notice{padding:10px 20px;border-bottom:1px solid var(--vsc-border);color:var(--vsc-warn);font-size:13px}.vsc .vsc-error{color:var(--vsc-danger);white-space:pre-wrap;overflow-wrap:anywhere}.vsc .vsc-workspace{display:flex;flex:1;min-height:450px;min-width:0;position:relative}.vsc .vsc-stage{position:relative;flex:1;min-width:0;min-height:450px;overflow:hidden;touch-action:none;overscroll-behavior:contain;background:radial-gradient(circle,color-mix(in srgb,var(--vsc-border) 65%,transparent) .8px,transparent 1px);background-size:22px 22px}.vsc .vsc-canvas{display:block;width:100%;height:100%;position:absolute;inset:0;min-height:450px;cursor:grab}.vsc .vsc-stage[data-dragging=true] .vsc-canvas{cursor:grabbing}.vsc .vsc-instructions{position:absolute;bottom:14px;left:18px;right:18px;pointer-events:none;color:var(--vsc-muted);font-size:11px}.vsc .vsc-empty{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;padding:32px;gap:12px;background:var(--vsc-bg)}.vsc .vsc-empty p{max-width:42ch;color:var(--vsc-muted)}
.vsc .vsc-node-frame{fill:var(--vsc-panel);stroke:var(--vsc-border);stroke-width:1.4}.vsc .vsc-compound>.vsc-node-frame{fill:color-mix(in srgb,var(--vsc-panel) 93%,var(--vsc-accent));stroke-dasharray:none}.vsc .vsc-node:focus{outline:none}.vsc .vsc-node:focus>.vsc-node-frame,.vsc .vsc-node[data-selected=true]>.vsc-node-frame{stroke:var(--vsc-accent);stroke-width:2.5}.vsc .vsc-node{cursor:pointer}.vsc .vsc-node-title{fill:var(--vsc-text);font-family:inherit;font-size:15px;font-weight:650}.vsc .vsc-node-meta{fill:var(--vsc-muted);font-family:inherit;font-size:11px}.vsc .vsc-node-status{fill:var(--vsc-muted)}.vsc .vsc-node[data-status=blocked] .vsc-node-status{fill:var(--vsc-danger)}.vsc .vsc-node[data-status=running] .vsc-node-status{fill:var(--vsc-accent)}.vsc .vsc-node-toggle{fill:var(--vsc-text);font-family:inherit;font-size:18px}.vsc .vsc-node[data-active=true]>.vsc-node-frame{stroke:var(--vsc-accent);stroke-dasharray:10 5;animation:vsc-orbit 1.8s linear infinite}.vsc .vsc-node[data-tool=true] .vsc-node-status{fill:var(--vsc-accent)}.vsc .vsc-edge{fill:none;stroke:var(--vsc-muted);stroke-width:1.5;opacity:.6}.vsc .vsc-edge[data-kind=resource]{stroke-dasharray:5 4}.vsc .vsc-edge[data-kind=audit]{stroke-dasharray:2 5}.vsc .vsc-edge[data-active=true]{stroke:var(--vsc-accent);stroke-width:2.5;stroke-dasharray:8 5;opacity:1;animation:vsc-orbit .8s linear infinite}.vsc .vsc-edge-label{fill:var(--vsc-muted);font-family:inherit;font-size:11px;paint-order:stroke;stroke:var(--vsc-bg);stroke-width:5px;stroke-linejoin:round}.vsc .vsc-edge-target{fill:var(--vsc-muted)}.vsc .vsc-node[data-recent=true] .vsc-node-status{fill:var(--vsc-accent)}
.vsc .vsc-inspector{flex:0 0 308px;width:308px;max-width:100%;border-left:1px solid var(--vsc-border);padding:20px;overflow:auto;max-height:calc(100vh - 180px);background:var(--vsc-panel)}.vsc .vsc-inspector-header{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}.vsc .vsc-inspector section{margin-top:22px}.vsc .vsc-purpose{margin-top:10px;color:var(--vsc-muted);white-space:pre-wrap;overflow-wrap:anywhere}.vsc dl{display:grid;grid-template-columns:minmax(70px,auto) 1fr;gap:8px 14px;font-size:12px;margin:14px 0}.vsc dt{color:var(--vsc-muted)}.vsc dd{margin:0;overflow-wrap:anywhere}.vsc .vsc-inspector ul{list-style:none;padding:0;margin:10px 0}.vsc .vsc-inspector li{padding:8px 0;border-bottom:1px solid var(--vsc-border);font-size:12px;overflow-wrap:anywhere}.vsc .vsc-inspector li time{display:block;color:var(--vsc-muted);font-size:11px}.vsc .vsc-inspector .vsc-button{margin:4px 4px 0 0}.vsc .vsc-form{display:flex;flex-direction:column;gap:14px;margin-top:18px}.vsc .vsc-field{display:flex;flex-direction:column;gap:5px;font-size:12px}.vsc input,.vsc select,.vsc textarea{font:inherit;color:inherit;background:var(--vsc-bg);border:1px solid var(--vsc-border);border-radius:5px;padding:8px;width:100%;min-height:36px}.vsc textarea{min-height:100px;resize:vertical}.vsc .vsc-form-actions{display:flex;gap:6px}.vsc .vsc-visually-hidden{position:absolute!important;clip:rect(0,0,0,0);clip-path:inset(50%);width:1px;height:1px;overflow:hidden;white-space:nowrap}
.vsc .vsc-compute{padding:24px;overflow:auto}.vsc .vsc-compute section+section{margin-top:32px}.vsc .vsc-section-heading{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:12px}.vsc .vsc-table-wrap{overflow-x:auto;border:1px solid var(--vsc-border);border-radius:8px}.vsc table{width:100%;border-collapse:collapse;text-align:left;font-size:13px}.vsc th{font-weight:550;color:var(--vsc-muted);font-size:12px;background:color-mix(in srgb,var(--vsc-border) 14%,transparent)}.vsc th,.vsc td{padding:12px 14px;vertical-align:top;border-bottom:1px solid var(--vsc-border)}.vsc tr:last-child td{border-bottom:0}.vsc td p+p{margin-top:5px}.vsc .vsc-quota{min-width:170px;margin-bottom:10px}.vsc .vsc-quota:last-child{margin-bottom:0}.vsc .vsc-quota-label{display:flex;justify-content:space-between;gap:12px;font-size:12px}.vsc progress{display:block;accent-color:var(--vsc-accent);width:100%;height:6px;margin:5px 0}.vsc .vsc-compute-empty{padding:18px 0;color:var(--vsc-muted);max-width:70ch}.vsc .vsc-compute .vsc-button{font-size:12px}.vsc .vsc-wrap{max-width:36ch;overflow-wrap:anywhere}.vsc.vsc-motion-paused *{animation:none!important}.vsc[data-reduced-motion=true] *{animation:none!important}
@keyframes vsc-orbit{to{stroke-dashoffset:-30}}
@media(prefers-reduced-motion:reduce){.vsc *{animation:none!important;scroll-behavior:auto!important}}
@media(max-width:800px){.vsc .vsc-workspace{flex-direction:column}.vsc .vsc-stage{flex:none;height:55vh;min-height:360px}.vsc .vsc-canvas{min-height:360px}.vsc .vsc-inspector{flex:none;width:100%;border-left:0;border-top:1px solid var(--vsc-border);max-height:45vh}.vsc .vsc-toolbar{padding:12px}.vsc .vsc-compute{padding:16px}.vsc .vsc-instructions{font-size:10px}.vsc .vsc-notice{padding:10px 12px}}
`;
