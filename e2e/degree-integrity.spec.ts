import { NOW, rule, spring2027 } from '../src/fastlane/__tests__/fixtures/spring2027-degree';
import { expect, test } from './fixtures';

test('a restored AI plan rechecks the current audit, shows redundancy, and updates after a record or schedule edit', async ({
    context,
    extensionId,
    sw,
}) => {
    const fixture = spring2027();
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    const network: string[] = [];
    await context.route('https://longhorn-fastlane-plus.vercel.app/api/**', route => {
        network.push(route.request().url());
        return route.abort();
    });
    // Only a fresh disposable test profile receives synthetic records; never the user's Chrome.
    await sw.evaluate(async data => {
        await chrome.storage.local.set({
            'FastlaneAudit:audit': data.audit,
            'FastlaneChat:session': {
                history: [],
                versions: [
                    {
                        id: 1,
                        sections: data.sections,
                        note: 'Synthetic regression plan',
                        added: [],
                        removed: [],
                        validation: {
                            hardOk: true,
                            allRulesMet: true,
                            checks: [],
                            unverified: [],
                            failures: [],
                            credits: 16,
                        },
                    },
                ],
                versionIndex: 0,
                pool: [],
                known: { sections: [], facts: [], grades: [], picks: [] },
                overrides: {},
                droppedTags: [],
                lastKind: 'schedule',
            },
        });
    }, fixture);
    await page.goto(`chrome-extension://${extensionId}/fastlane.html#finder`);
    const fit = page.getByRole('region', { name: 'Degree fit for this plan', exact: true });
    await expect(fit).toBeVisible();
    await expect(fit).toContainText('9 planned degree-applicable hours identified');
    const music = fit.getByRole('listitem', { name: 'Degree fit for MUS 302L' });
    await expect(music).toContainText('Redundant for this requirement');
    await expect(fit.getByRole('listitem', { name: 'Degree fit for EDC 312' })).toContainText('Redundant');
    await expect(fit.getByRole('listitem', { name: 'Degree fit for PED 106C' })).toContainText('Excluded');
    const plan = page.getByRole('region', { name: 'Proposed schedule', exact: true });
    await expect(plan.locator('.fl-pill').first()).not.toHaveText('All rules met');
    await page.setViewportSize({ width: 1440, height: 1600 });
    await fit.scrollIntoViewIfNeeded();
    await fit.screenshot({ path: 'reports/screenshots/degree-integrity.png' });
    // An audit update invalidates the saved model verdict and current planned contributions immediately.
    const updated = {
        ...fixture.audit,
        requirements: fixture.audit.requirements.map(r => (r.id === 'CORE 050' ? rule('CORE 050', 3, 3) : r)),
        parsedAt: NOW + 1,
    };
    await sw.evaluate(async audit => {
        await chrome.storage.local.set({ 'FastlaneAudit:audit': audit });
    }, updated);
    await expect(fit).toContainText('6 planned degree-applicable hours identified');
    await expect(fit.getByRole('listitem', { name: 'Degree fit for T D 301' })).toContainText('Redundant');
    await page.reload();
    await expect(fit).toContainText('6 planned degree-applicable hours identified');
    expect(network).toEqual([]);
    expect(errors).toEqual([]);
});
