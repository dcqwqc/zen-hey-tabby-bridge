# QWQC Hey Tabby Voice Bridge

Thin Zen/Sine bridge for the local Hey Tabby companion.

Protocol7 focuses Zen and sends Ctrl+Alt+Shift+V. This mod prefers a pinned
chatgpt.com tab, focuses it, and asks a dedicated JSWindowActor in the content
process to activate the real ChatGPT Voice control.

The bridge intentionally does not read conversation messages, extract ChatGPT
responses, or use fixed screen coordinates. It only finds the Voice control by
semantic DOM metadata and clicks it. The rest of the assistant remains outside
the browser.

## Architecture

Hey Tabby -> Protocol7 -> focus Zen -> Ctrl+Alt+Shift+V -> Sine chrome script
-> QwqcHeyTabby JSWindowActor -> ChatGPT Voice button

Keep the intended Companion chat pinned in Zen. If no pinned ChatGPT tab exists,
the most recently accessed ChatGPT tab is used. If no ChatGPT tab exists, one is
opened.

Run scripts/deploy-local.sh to install into the active Zen profile. Restart Zen
or toggle the mod in Sine to load the new userChrome script.


## v0.5 runtime

The bridge hosts ChatGPT in a minimal standalone Gecko chrome window containing exactly one `<browser>` element. It shares the signed-in Zen/Firefox profile and WebRTC stack, but has no Zen tabs, sidebar, toolbar, or browser chrome. Debug mode only moves that window between `special:tabby` and the active workspace.


### Conversation lifecycle

Bridge v0.6 adds separate `continue-chat` and `new-chat` operations. `end` stops Voice without navigating away from the active conversation, allowing Tabby to resume the same `/c/...` thread after closing or backend/shell restarts. Fresh-chat navigation uses the parent Gecko `<browser>` and a real `nsIURI`, avoiding WindowActor destruction races. Text sending waits for ChatGPT's hydrated, enabled Send control before clicking.
