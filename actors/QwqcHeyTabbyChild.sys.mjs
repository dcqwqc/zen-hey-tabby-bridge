export class QwqcHeyTabbyChild extends JSWindowActorChild {
  static labelFor(element) {
    if (!element) return "";
    return [
      element.getAttribute?.("aria-label") || "",
      element.getAttribute?.("title") || "",
      element.getAttribute?.("data-testid") || "",
      element.textContent || "",
    ].join(" ").replace(/\s+/g, " ").trim().toLowerCase();
  }

  visible(element) {
    if (!element) return false;
    const style = this.contentWindow.getComputedStyle(element);
    const rect = element.getBoundingClientRect?.();
    return style?.display !== "none" && style?.visibility !== "hidden" && (!rect || (rect.width > 0 && rect.height > 0));
  }

  candidates() {
    const document = this.document;
    if (!document) return [];
    return Array.from(document.querySelectorAll(
      'button, [role="button"], a, [data-testid*="voice"], [aria-label*="voice" i], [aria-label*="stimm" i], [aria-label*="sprach" i]'
    )).filter(element => this.visible(element))
      .map(element => ({ element, label: QwqcHeyTabbyChild.labelFor(element) }));
  }

  findComposer() {
    const doc = this.document;
    if (!doc) return null;
    const selectors = [
      '#prompt-textarea',
      'textarea[data-testid*="prompt"]',
      'textarea[placeholder]',
      '[contenteditable="true"][data-testid*="composer"]',
      'div[contenteditable="true"][role="textbox"]',
      '[contenteditable="true"]',
    ];
    for (const selector of selectors) {
      const nodes = Array.from(doc.querySelectorAll(selector));
      const hit = nodes.find(node => this.visible(node));
      if (hit) return hit;
    }
    return null;
  }

  findSendButton() {
    const doc = this.document;
    if (!doc) return null;
    const candidates = Array.from(doc.querySelectorAll('button,[role="button"]'))
      .filter(el => this.visible(el))
      .map(el => ({ el, label: QwqcHeyTabbyChild.labelFor(el) }));
    return candidates.find(({ el, label }) =>
      el.getAttribute?.('data-testid') === 'send-button' ||
      /^(send|send prompt|send message|submit)$/.test(label) ||
      /send.*(prompt|message)/.test(label)
    )?.el || null;
  }

  state() {
    const entries = this.candidates();
    const href = this.document?.location?.href || "";
    const loggedOut = entries.some(({ label, element }) => {
      const link = element.getAttribute?.("href") || "";
      return /^(log in|login|sign up|sign up for free|log in or create account)$/.test(label) || /\/auth\/login/.test(link);
    });
    const activeControl = entries.find(({ label }) =>
      /((end|stop|leave|exit|close).*(voice|sprach|stimm))|((voice|sprach|stimm).*(end|stop|leave|exit|close))/.test(label)
    );
    const startControl = entries.find(({ label, element }) => {
      const link = element.getAttribute?.("href") || "";
      return label === "start voice" ||
        /(start|open|enter|begin).*(voice|sprach|stimm)/.test(label) ||
        /[?&]mode=voice(?:$|&)/.test(link);
    });
    const active = Boolean(activeControl) || /[?&]mode=voice(?:$|&)/.test(href);

    const busyElement = this.document?.querySelector?.('[data-testid*="stop-button"], .result-streaming');
    const workingButton = entries.find(({ label }) =>
      /(stop generating|stop response|cancel response|interrupt response|searching the web|working on your request)/.test(label)
    );
    // Voice mode itself contains persistent controls such as the model's
    // "Thinking effort" selector. Those are metadata, not evidence that the
    // assistant is currently thinking. While Voice is active the standalone
    // Tabby backend derives speaking/listening from real output amplitude.
    const working = !active && Boolean((busyElement && this.visible(busyElement)) || workingButton);

    return {
      active,
      ready: Boolean(startControl),
      loggedOut,
      working,
      composerReady: Boolean(this.findComposer()),
      href,
      title: this.document?.title || "",
      activeControl: activeControl?.element || null,
      startControl: startControl?.element || null,
    };
  }

  trustedClick(element) {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    const x = Math.max(1, rect.left + rect.width / 2);
    const y = Math.max(1, rect.top + rect.height / 2);
    try {
      const utils = this.contentWindow.windowUtils;
      utils.sendMouseEvent("mousemove", x, y, 0, 0, 0);
      utils.sendMouseEvent("mousedown", x, y, 0, 1, 0);
      utils.sendMouseEvent("mouseup", x, y, 0, 1, 0);
      return true;
    } catch (_) {
      try {
        element.focus?.({ preventScroll: true });
        element.click();
        return true;
      } catch (_) {
        return false;
      }
    }
  }

  async waitForActive(timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = this.state();
      if (state.active) return state;
      await new Promise(resolve => this.contentWindow.setTimeout(resolve, 180));
    }
    return this.state();
  }

  async waitForComposer(timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const composer = this.findComposer();
      if (composer) return composer;
      await new Promise(resolve => this.contentWindow.setTimeout(resolve, 140));
    }
    return this.findComposer();
  }

  async activateVoice() {
    // Do not wait for the active Voice UI inside this WindowActor query.
    // ChatGPT rehydrates/navigates the Voice surface after the click, which
    // can destroy or replace this actor before the query resolves. The parent
    // bridge performs the active-state polling against the freshly attached
    // actor instead.
    for (let attempt = 0; attempt < 70; attempt++) {
      const state = this.state();
      if (state.active) return { ok: true, result: "already-active", ...this.publicState(state) };
      if (state.startControl) {
        if (!this.trustedClick(state.startControl))
          return { ok: false, result: "voice-click-failed", ...this.publicState(state) };
        return { ok: true, result: "starting", ...this.publicState(state) };
      }
      await new Promise(resolve => this.contentWindow.setTimeout(resolve, 120));
    }
    const state = this.state();
    return { ok: false, result: state.loggedOut ? "needs-login" : "voice-button-not-found", ...this.publicState(state) };
  }

  publicState(state = this.state()) {
    return {
      active: Boolean(state.active),
      ready: Boolean(state.ready),
      loggedOut: Boolean(state.loggedOut),
      working: Boolean(state.working),
      composerReady: Boolean(state.composerReady),
      href: state.href || "",
      title: state.title || "",
    };
  }

  async endVoice() {
    const state = this.state();
    if (!state.active) return { ok: true, result: "already-inactive", ...this.publicState(state) };
    if (state.activeControl) this.trustedClick(state.activeControl);
    await new Promise(resolve => this.contentWindow.setTimeout(resolve, 350));
    const after = this.state();
    return { ok: !after.active, result: after.active ? "end-click-failed" : "ended", ...this.publicState(after) };
  }

  setComposerText(composer, text) {
    composer.focus?.({ preventScroll: true });
    if (composer instanceof this.contentWindow.HTMLTextAreaElement || composer instanceof this.contentWindow.HTMLInputElement) {
      const proto = composer instanceof this.contentWindow.HTMLTextAreaElement
        ? this.contentWindow.HTMLTextAreaElement.prototype
        : this.contentWindow.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(composer, text);
      else composer.value = text;
    } else {
      composer.textContent = text;
    }
    try {
      composer.dispatchEvent(new this.contentWindow.InputEvent("input", {
        bubbles: true,
        cancelable: false,
        inputType: "insertText",
        data: text,
      }));
    } catch (_) {
      composer.dispatchEvent(new this.contentWindow.Event("input", { bubbles: true }));
    }
    composer.dispatchEvent(new this.contentWindow.Event("change", { bubbles: true }));
  }

  async clearComposer() {
    const composer = await this.waitForComposer();
    if (!composer) return { ok: false, result: "composer-not-found", ...this.publicState() };
    this.setComposerText(composer, "");
    // Some contenteditable implementations retain a lone <br>/newline after
    // clearing. Dispatch Backspace once through the trusted page window and
    // then normalize the DOM again so ChatGPT sees a truly empty prompt.
    try {
      composer.focus?.({ preventScroll: true });
      const utils = this.contentWindow.windowUtils;
      utils.sendKeyEvent("keydown", 8, 0, 0);
      utils.sendKeyEvent("keyup", 8, 0, 0);
    } catch (_) {}
    if (!(composer instanceof this.contentWindow.HTMLTextAreaElement) && !(composer instanceof this.contentWindow.HTMLInputElement)) {
      composer.textContent = "";
      composer.innerHTML = "";
      composer.dispatchEvent(new this.contentWindow.Event("input", { bubbles: true }));
    }
    await new Promise(resolve => this.contentWindow.setTimeout(resolve, 220));
    let length = 0;
    if ("value" in composer) length = String(composer.value || "").length;
    else length = String(composer.innerText || composer.textContent || "").trim().length;
    return { ok: length === 0, result: length === 0 ? "composer-cleared" : "composer-not-empty", composerTextLength: length, ...this.publicState() };
  }

  async sendText(text) {
    const composer = await this.waitForComposer();
    if (!composer) return { ok: false, result: "composer-not-found", ...this.publicState() };
    const clean = String(text ?? "");
    if (clean.length > 0) this.setComposerText(composer, clean);
    let send = null;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      send = this.findSendButton();
      const disabled = send && (send.disabled || send.getAttribute?.("aria-disabled") === "true");
      if (send && !disabled) break;
      send = null;
      await new Promise(resolve => this.contentWindow.setTimeout(resolve, 100));
    }
    if (!send) return { ok: false, result: "send-button-not-found", ...this.publicState() };
    if (!this.trustedClick(send)) return { ok: false, result: "send-click-failed", ...this.publicState() };
    await new Promise(resolve => this.contentWindow.setTimeout(resolve, 180));
    return { ok: true, result: "sent", ...this.publicState() };
  }

  async newChat() {
    try {
      // Always hard-navigate Tabby's dedicated tab to the canonical fresh
      // composer. This never touches the user's normal selected ChatGPT tab.
      this.contentWindow.location.assign("https://chatgpt.com/?tabby=1");
      return { ok: true, result: "navigating" };
    } catch (error) {
      return { ok: false, result: "new-chat-navigation-failed", error: String(error) };
    }
  }

  async pasteImage(payload) {
    const composer = await this.waitForComposer();
    if (!composer) return { ok: false, result: "composer-not-found", ...this.publicState() };
    const b64 = String(payload?.base64 || "");
    if (!b64) return { ok: false, result: "missing-image", ...this.publicState() };
    try {
      const binary = this.contentWindow.atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const mime = String(payload?.mime || "image/png");
      const name = String(payload?.name || "tabby-paste.png");
      const file = new this.contentWindow.File([bytes], name, { type: mime });
      const transfer = new this.contentWindow.DataTransfer();
      transfer.items.add(file);

      const findInputs = () => Array.from(this.document.querySelectorAll('input[type="file"]'));
      let inputs = findInputs();
      // ChatGPT hydrates its hidden attachment inputs slightly after the text
      // composer. Wait for that normal path first instead of racing it.
      let inputDeadline = Date.now() + 3500;
      while (!inputs.length && Date.now() < inputDeadline) {
        await new Promise(resolve => this.contentWindow.setTimeout(resolve, 100));
        inputs = findInputs();
      }
      if (!inputs.length) {
        const add = this.candidates().find(({ label }) =>
          /(add files and more|attach files|add files|upload|paperclip)/.test(label)
        );
        if (add?.element) {
          this.trustedClick(add.element);
          inputDeadline = Date.now() + 3000;
          while (Date.now() < inputDeadline) {
            inputs = findInputs();
            if (inputs.length) break;
            await new Promise(resolve => this.contentWindow.setTimeout(resolve, 100));
          }
        }
      }

      let fileInput = inputs.find(input => {
        const accept = String(input.getAttribute("accept") || "").toLowerCase();
        return accept === "" || accept.includes("image") || accept.includes("*");
      }) || inputs[0] || null;

      let method = "paste";
      if (fileInput) {
        try {
          fileInput.files = transfer.files;
          fileInput.dispatchEvent(new this.contentWindow.Event("input", { bubbles: true }));
          fileInput.dispatchEvent(new this.contentWindow.Event("change", { bubbles: true }));
          method = "file-input";
        } catch (_) {
          fileInput = null;
        }
      }

      if (method === "paste") {
        composer.focus?.({ preventScroll: true });
        const event = new this.contentWindow.ClipboardEvent("paste", {
          clipboardData: transfer,
          bubbles: true,
          cancelable: true,
          composed: true,
        });
        composer.dispatchEvent(event);
      }

      const deadline = Date.now() + 7000;
      let attachment = null;
      let byName = false;
      while (Date.now() < deadline) {
        attachment = this.document.querySelector(
          '[data-testid*="attachment"], [aria-label*="remove file" i], [aria-label*="remove image" i], [data-testid*="file"] img, img[src^="blob:"], img[alt*="upload" i]'
        );
        byName = String(this.document.body?.innerText || "").includes(name);
        if (attachment || byName) break;
        await new Promise(resolve => this.contentWindow.setTimeout(resolve, 160));
      }
      return {
        ok: Boolean(attachment || byName),
        result: (attachment || byName) ? "image-attached" : "image-attachment-not-detected",
        method,
        attachmentDetected: Boolean(attachment || byName),
        fileInputCount: inputs.length,
        ...this.publicState(),
      };
    } catch (error) {
      return { ok: false, result: "image-paste-failed", error: String(error), ...this.publicState() };
    }
  }

  latestAssistantResponse() {
    const doc = this.document;
    if (!doc) return { ok: false, result: "document-unavailable", assistantCount: 0, assistantText: "" };

    const semantic = Array.from(doc.querySelectorAll('[data-message-author-role="assistant"]'));
    let text = "";
    let messageId = "";
    let assistantCount = semantic.length;

    if (semantic.length) {
      const latest = semantic[semantic.length - 1];
      const content = latest.querySelector(
        '.markdown, [class*="markdown"], [data-message-content], [class*="prose"]'
      ) || latest;
      text = String(content.innerText || content.textContent || "").trim();
      const host = latest.closest?.('[data-message-id]') || latest;
      messageId = String(host?.getAttribute?.('data-message-id') || "");
    } else {
      // The current ChatGPT renderer virtualizes turns without message-role
      // attributes. Assistant action controls remain stable, so anchor on the
      // last response's Read aloud / Regenerate controls and walk to its turn.
      const controls = Array.from(doc.querySelectorAll('button,[role="button"]')).filter(el => this.visible(el));
      const responseAnchors = controls.filter(el => {
        const label = QwqcHeyTabbyChild.labelFor(el);
        return /^(read aloud|regenerate response)$/.test(label);
      });
      assistantCount = responseAnchors.filter(el => QwqcHeyTabbyChild.labelFor(el) === 'read aloud').length;
      const anchor = responseAnchors[responseAnchors.length - 1] || null;
      let turn = anchor;
      for (let i = 0; turn && i < 10; i++, turn = turn.parentElement) {
        const raw = String(turn.innerText || turn.textContent || "").trim();
        const marker = raw.lastIndexOf("ChatGPT said:");
        if (marker >= 0) {
          text = raw.slice(marker + "ChatGPT said:".length).trim();
          const nextUser = text.indexOf("\nYou said:");
          if (nextUser >= 0) text = text.slice(0, nextUser).trim();
          break;
        }
      }
    }

    text = text.replace(/\n(?:Copy|Share|Read aloud|Regenerate response|React|Bad response|More actions)(?:\n.*)*$/i, "").trim();
    return {
      ok: true,
      result: text ? "latest-assistant-response" : "no-assistant-message",
      assistantCount,
      assistantText: text.slice(0, 12000),
      assistantMessageId: messageId,
      ...this.publicState(),
    };
  }

  debugAllControls() {
    const doc = this.document;
    const rows = Array.from(doc?.querySelectorAll?.('button,[role="button"],input,textarea,[contenteditable="true"]') || [])
      .filter(el => this.visible(el) || el.tagName === "INPUT")
      .slice(0, 180)
      .map(el => ({
        tag: el.tagName,
        type: el.getAttribute?.("type") || "",
        label: QwqcHeyTabbyChild.labelFor(el).slice(0, 180),
        testid: el.getAttribute?.("data-testid") || "",
        aria: el.getAttribute?.("aria-label") || "",
        title: el.getAttribute?.("title") || "",
      }));
    return { ok:true, result:"debug-all", count:rows.length, rows, ...this.publicState() };
  }

  debugComposer() {
    const doc = this.document;
    const composer = this.findComposer();
    let composerTextLength = 0;
    if (composer) {
      if ("value" in composer) composerTextLength = String(composer.value || "").length;
      else composerTextLength = String(composer.innerText || composer.textContent || "").length;
    }
    const send = this.findSendButton();
    const buttons = Array.from(doc?.querySelectorAll?.('button,[role="button"],input') || [])
      .filter(el => this.visible(el) || el.tagName === "INPUT")
      .map(el => ({
        tag: el.tagName,
        type: el.getAttribute?.("type") || "",
        label: QwqcHeyTabbyChild.labelFor(el).slice(0, 180),
        accept: el.getAttribute?.("accept") || "",
        testid: el.getAttribute?.("data-testid") || "",
      }))
      .filter(x => /attach|file|photo|image|upload|add|plus|paperclip|clip|voice|dictat|send/.test(JSON.stringify(x).toLowerCase()) || x.type === "file")
      .slice(0, 80);
    return {
      ok: true,
      result: "debug",
      composerTextLength,
      composerEmpty: composerTextLength === 0,
      sendPresent: Boolean(send),
      sendDisabled: send ? Boolean(send.disabled || send.getAttribute?.("aria-disabled") === "true") : null,
      buttons,
      ...this.publicState(),
    };
  }

  async receiveMessage(message) {
    switch (message.name) {
      case "activateVoice": return this.activateVoice();
      case "endVoice": return this.endVoice();
      case "newChat": return this.newChat();
      case "clearComposer": return this.clearComposer();
      case "sendText": return this.sendText(message.data?.text ?? "");
      case "pasteImage": return this.pasteImage(message.data || {});
      case "latestAssistantResponse": return this.latestAssistantResponse();
      case "debugComposer": return this.debugComposer();
      case "debugAllControls": return this.debugAllControls();
      case "voiceStatus": return { ok: true, result: "status", ...this.publicState() };
      default: return { ok: false, result: "unknown-message" };
    }
  }
}
