/**
 * Small, non-blocking notice shown in a UT tab whose Fastlane script was left behind by an extension
 * reload or update. It never refreshes the page by itself (the student may have unsaved input).
 */
export const STALE_NOTICE_ID = 'fastlane-stale-tab-notice';

export function showStaleTabNotice(doc: Document = document): HTMLElement | null {
    if (!doc.body || doc.getElementById(STALE_NOTICE_ID)) return null;
    const host = doc.createElement('div');
    host.id = STALE_NOTICE_ID;
    const shadow = host.attachShadow({ mode: 'open' });
    const style = doc.createElement('style');
    style.textContent =
        ':host{position:fixed;right:16px;bottom:16px;z-index:2147483000;font:14px/1.45 system-ui,sans-serif;color:#1c1917}' +
        'section{max-width:320px;padding:12px 14px;border:1px solid #e2ded6;border-radius:12px;background:#fff;box-shadow:0 8px 24px #0002}' +
        'p{margin:0 0 8px}div{display:flex;gap:8px;justify-content:flex-end}' +
        'button{font:600 13px system-ui;border-radius:9px;padding:6px 12px;cursor:pointer;border:1px solid #e2ded6;background:#fff;color:#1c1917}' +
        'button.primary{background:#bf5700;border-color:#bf5700;color:#fff}';
    const panel = doc.createElement('section');
    panel.setAttribute('role', 'status');
    const text = doc.createElement('p');
    text.textContent =
        'Fastlane was updated. Refresh this page when you are ready to use Fastlane here again. Nothing on this page was changed.';
    const actions = doc.createElement('div');
    const dismiss = doc.createElement('button');
    dismiss.type = 'button';
    dismiss.textContent = 'Dismiss';
    dismiss.onclick = () => host.remove();
    const refresh = doc.createElement('button');
    refresh.type = 'button';
    refresh.className = 'primary';
    refresh.textContent = 'Refresh page';
    refresh.onclick = () => doc.defaultView?.location.reload();
    actions.append(dismiss, refresh);
    panel.append(text, actions);
    shadow.append(style, panel);
    doc.body.append(host);
    return host;
}
