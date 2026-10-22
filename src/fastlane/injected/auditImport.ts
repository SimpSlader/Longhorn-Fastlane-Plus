import { parseAuditHtml } from '../audit/parseAudit';
import { isContextInvalidatedError } from '../services/extensionContext';
import { sendFastlane } from '../services/runtime';
import { FastlaneAuditStore } from '../storage/stores';

/** No audit is read until the student clicks. Never persist HTML, page URL, or account identifiers. */
export function mountAuditImport() {
    if (
        location.origin !== 'https://utdirect.utexas.edu' ||
        !/^\/apps\/degree\/audits\/results\/\d+\/?$/.test(location.pathname)
    )
        return;
    if (document.getElementById('fastlane-ida')) return;
    const host = document.createElement('div');
    host.id = 'fastlane-ida';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent =
        ':host{position:fixed;bottom:24px;right:24px;z-index:2147483000;font:14px system-ui;color:#222}section{max-width:300px;padding:16px;border:1px solid #fff;border-radius:18px;background:rgba(255,255,255,.94);backdrop-filter:blur(20px);box-shadow:0 8px 32px #0002}button{background:#bf5700;color:white;border:0;padding:10px 18px;border-radius:10px;cursor:pointer;font:600 14px system-ui}p{line-height:1.5;margin:8px 0}';
    const panel = document.createElement('section');
    const button = document.createElement('button');
    button.textContent = 'Add IDA';
    const note = document.createElement('p');
    note.textContent = 'FastLane · Import this audit into this browser only. Replaces your previously imported audit.';
    note.setAttribute('role', 'status');
    button.onclick = async () => {
        button.disabled = true;
        try {
            const audit = parseAuditHtml(document);
            // The page heading can contain a student name; academic rows are sufficient.
            delete audit.program;
            if (!audit.requirements.length && !audit.courses.length)
                throw new Error(
                    'No readable audit found. Open your completed IDA results, or use file import in FastLane.'
                );
            await FastlaneAuditStore.set('audit', audit as never);
            note.textContent = `Added ${audit.requirements.length} requirements and ${audit.courses.length} courses locally. Review any uncertain matches in My degree progress.`;
            button.textContent = 'Review IDA';
            button.onclick = () => {
                sendFastlane({ type: 'openFastlane', tab: 'audit' }).catch(error => {
                    note.textContent = isContextInvalidatedError(error)
                        ? 'Fastlane was updated. Refresh this page, then open My degree progress from the Fastlane menu.'
                        : 'Could not open Fastlane. Open it from the extension menu instead.';
                    if (!isContextInvalidatedError(error)) console.error(error);
                });
            };
        } catch (error) {
            note.textContent = isContextInvalidatedError(error)
                ? 'Fastlane was updated. Refresh this page and import again; nothing was saved.'
                : error instanceof Error
                  ? error.message
                  : 'Could not import this audit.';
        } finally {
            button.disabled = false;
        }
    };
    panel.append(button, note);
    shadow.append(style, panel);
    document.body.append(host);
}
