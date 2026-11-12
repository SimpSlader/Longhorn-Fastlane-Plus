# Install Fastlane Course Planner from GitHub

You do **not** need to install Node.js, pnpm, VS Code, or anything from a terminal. You only need **desktop Google Chrome** and the prebuilt ZIP.

## Install in five steps

1. Go to **[Fastlane GitHub Releases](https://github.com/SimpSlader/Longhorn-Fastlane-Plus/releases)** and open the newest release titled **Fastlane friend install**.
2. Under **Assets**, download **`fastlane-course-planner-<version>.zip`**. **Do not** download the GitHub **Source code (zip)** file: source code is not a Chrome-ready extension.
3. Extract the downloaded ZIP to a folder you will keep, such as `Documents/Fastlane`. Open it and confirm **`manifest.json`** is directly inside that folder.
4. In Chrome, paste **`chrome://extensions`** into the address bar. Enable **Developer mode** (top right), click **Load unpacked**, and choose that folder containing `manifest.json`.
5. The **Fastlane Course Planner** extension should appear. Optionally pin it from Chrome's Extensions/puzzle-piece menu. Sign into the UT sites normally to use course-schedule integrations. Fastlane does **not** enroll you in classes automatically.

That's it. No API keys or development setup are required just to install and use the core extension.

## Updating your copy

GitHub-installed, unpacked extensions **do not update automatically**.

1. Download the newest **Fastlane friend install** ZIP from [Releases](https://github.com/SimpSlader/Longhorn-Fastlane-Plus/releases).
2. Extract the **contents** over the files in the **same folder** you originally loaded (don't move or rename the folder).
3. Open `chrome://extensions` and click **Reload** on Fastlane. Refresh your open UT tabs.

Keep the original folder and do not remove/re-add the extension just to update: changing the extension location/identity can result in losing access to its locally stored plans. For extra safety, export your plans through **Fastlane Settings → Your data** before updating.

## Common issues

| Issue | Fix |
| --- | --- |
| I only see **Source code (zip)** | You are not looking at a published installable preview. The build must pass CI before a **Fastlane friend install** release appears. Ask the maintainer for a tested ZIP. |
| **Manifest file is missing or unreadable** | Extract the ZIP first, then choose the **inner folder containing `manifest.json`**, not the ZIP or an enclosing downloads folder. |
| I downloaded GitHub's **Code → Download ZIP** | That is developer source. Use the ZIP under **Releases → Assets**, which is already built. |
| Features appear twice on UT pages | Disable **UT Registration Plus** or another installed Fastlane version; both can inject into the same page. |
| Fastlane doesn't appear on UT's schedule page | Make sure the extension is enabled, refresh the page, and sign in to UT normally. Some features only work on the relevant UT pages. |
| The extension appears but an AI feature doesn't work | Some online features need an available service or additional configuration; the extension itself does not require a local server to launch. |

## Safety and limitations

This is an **independent student project** and a **preview**, not an official UT Austin or Chrome Web Store release. Only install builds from the repo you trust. Chrome's Developer mode is necessary for manual, unpacked installations; Chrome may show warnings about developer-mode extensions. The GitHub preview is created only after automated build, security and browser checks succeed, but that does not replace careful manual testing.

This extension helps plan registration; **you remain responsible for submitting every registration request yourself**.

## For developers only

If you want to change the code instead of installing a prebuilt ZIP, see the [README's build-from-source section](README.md#build-from-source). The short version is Node 24, pnpm 10, `pnpm install`, `pnpm build`, then Chrome's **Load unpacked** from `dist/`.
