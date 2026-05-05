/**
 * MessageInput component — textarea with send, reply bar, and edit mode.
 * Step 5.42 of the Tauri v2 migration.
 */

import { createElement, appendChildren, setText } from "@lib/dom";
import { createIcon } from "@lib/icons";
import type { MountableComponent } from "@lib/safe-render";
import type { Attachment } from "@lib/types";
import { createEmojiPicker } from "@components/EmojiPicker";
import { createGifPicker } from "@components/GifPicker";

export interface MessageInputOptions {
  readonly channelId: number;
  readonly channelName: string;
  readonly onSend: (
    content: string,
    replyTo: number | null,
    attachments: readonly string[],
    attachmentMeta: readonly Attachment[],
  ) => void;
  readonly onUploadFile?: (file: File) => Promise<{ id: string; url: string; filename: string }>;
  readonly onTyping: () => void;
  readonly onEditMessage: (messageId: number, content: string) => void;
}

export type MessageInputComponent = MountableComponent & {
  setReplyTo(messageId: number, username: string): void;
  clearReply(): void;
  startEdit(messageId: number, content: string): void;
  cancelEdit(): void;
};

const TYPING_THROTTLE_MS = 3_000;
const MAX_TEXTAREA_HEIGHT = 200;
const SEND_DEBOUNCE_MS = 200;
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB matches server limit
const MAX_ATTACHMENTS_PER_MESSAGE = 10;
const ALLOWED_TYPES = [
  "image/",
  "video/",
  "audio/",
  "application/pdf",
  "text/",
  "application/zip",
  "application/x-zip-compressed",
  "application/json",
];

export function createMessageInput(
  options: MessageInputOptions,
): MessageInputComponent {
  const ac = new AbortController();
  const signal = ac.signal;
  let root: HTMLDivElement | null = null;
  let state = { replyTo: null as { messageId: number; username: string } | null,
    editing: null as { messageId: number } | null };
  let lastTypingTime = 0;
  let lastSendTime = 0;

  let textarea: HTMLTextAreaElement | null = null;
  let replyBar: HTMLDivElement | null = null;
  let replyText: HTMLSpanElement | null = null;
  let editBar: HTMLDivElement | null = null;
  let attachmentPreviewBar: HTMLDivElement | null = null;

  /** Pending attachments to send with the next message. */
  const pendingAttachments: Array<{
    id: string;
    filename: string;
    readonly previewEl: HTMLDivElement;
    uploaded: Attachment | null;
    progressTimer: ReturnType<typeof setInterval> | null;
  }> = [];
  /** Count of file uploads currently in flight. */
  let pendingUploadCount = 0;
  /** References to picker close functions, set by mount() for destroy() to call. */
  let cleanupPickers: (() => void) | null = null;
  /** Timer IDs for cleanup on destroy. */
  const activeTimers: Set<ReturnType<typeof setTimeout>> = new Set();

  function showReplyBar(username: string): void {
    if (replyBar === null || replyText === null) return;
    setText(replyText, `Replying to @${username}`);
    replyBar.classList.add("visible");
  }

  function hideReplyBar(): void { replyBar?.classList.remove("visible"); }
  function showEditBar(): void { editBar?.classList.add("visible"); }
  function hideEditBar(): void { editBar?.classList.remove("visible"); }

  function autoResize(): void {
    if (textarea === null) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
  }

  function maybeEmitTyping(): void {
    const now = Date.now();
    if (now - lastTypingTime >= TYPING_THROTTLE_MS) {
      lastTypingTime = now;
      options.onTyping();
    }
  }

  function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }

  function clearPendingAttachments(): void {
    for (const att of pendingAttachments) {
      if (att.progressTimer !== null) {
        clearInterval(att.progressTimer);
      }
      att.previewEl.remove();
    }
    pendingAttachments.length = 0;
    if (attachmentPreviewBar !== null) {
      attachmentPreviewBar.classList.remove("visible");
    }
  }

  function showUploadError(message: string): void {
    if (attachmentPreviewBar === null) return;
    const errEl = createElement("div", {
      class: "attachment-upload-error",
    }, message);
    attachmentPreviewBar.appendChild(errEl);
    const t = setTimeout(() => { activeTimers.delete(t); errEl.remove(); }, 4000);
    activeTimers.add(t);
  }

  function attachFiles(files: readonly File[]): void {
    if (options.onUploadFile === undefined || attachmentPreviewBar === null) return;
    const realFiles = files.filter((file) => file.name.trim() !== "");
    if (realFiles.length === 0) return;

    const remainingSlots = Math.max(0, MAX_ATTACHMENTS_PER_MESSAGE - pendingAttachments.length);
    if (remainingSlots === 0) {
      showUploadError(`Можно прикрепить не больше ${MAX_ATTACHMENTS_PER_MESSAGE} файлов`);
      return;
    }

    const accepted = realFiles.slice(0, remainingSlots);
    if (realFiles.length > remainingSlots) {
      showUploadError(`Можно прикрепить не больше ${MAX_ATTACHMENTS_PER_MESSAGE} файлов`);
    }

    for (const file of accepted) {
      void handlePasteFile(file);
    }
    textarea?.focus();
    updateSendBtnIcon();
  }

  function hasDraggedFiles(e: DragEvent): boolean {
    return Array.from(e.dataTransfer?.types ?? []).includes("Files");
  }

  function handleSend(): void {
    if (textarea === null) return;
    const content = textarea.value.trim();
    const hasAttachments = pendingAttachments.length > 0;
    if (content.length === 0 && !hasAttachments) return;

    // Block send while uploads are still in flight
    if (pendingUploadCount > 0) {
      showUploadError("Please wait for uploads to finish");
      return;
    }

    // Debounce to prevent double-click duplicate sends
    const now = Date.now();
    if (now - lastSendTime < SEND_DEBOUNCE_MS) return;
    lastSendTime = now;

    if (state.editing !== null) {
      options.onEditMessage(state.editing.messageId, content);
      cancelEdit();
    } else {
      const uploadedAttachments = pendingAttachments
        .map((a) => a.uploaded)
        .filter((a): a is Attachment => a !== null);
      const attachmentIds = uploadedAttachments.map((a) => a.id);
      options.onSend(content, state.replyTo?.messageId ?? null, attachmentIds, uploadedAttachments);
      clearReply();
      clearPendingAttachments();
    }

    textarea.value = "";
    autoResize();
    textarea.focus();
    updateSendBtnIcon();
  }

  function updateSendBtnIcon(): void {
    if (sendBtn === null) return;
    const hasContent = (textarea !== null && textarea.value.trim().length > 0) || pendingAttachments.length > 0;
    if (hasContent && micMode) {
      micMode = false;
      sendBtn.innerHTML = "";
      sendBtn.classList.add("send-btn");
      sendBtn.appendChild(createIcon("send", 20));
    } else if (!hasContent && !micMode) {
      micMode = true;
      sendBtn.innerHTML = "";
      sendBtn.classList.remove("send-btn");
      sendBtn.appendChild(createIcon("mic", 20));
    }
  }

  let micMode = true;
  let sendBtn: HTMLButtonElement | null = null;
  let recordingOverlay: HTMLDivElement | null = null;
  let recordingTimeStr: HTMLSpanElement | null = null;
  let mediaRecorder: MediaRecorder | null = null;
  let audioChunks: Blob[] = [];
  let recordStartTime = 0;
  let recordInterval: ReturnType<typeof setInterval> | null = null;
  let isRecording = false;
  let canceled = false;
  let startX = 0;

  /** Unique counter for preview items (before upload completes and we have a server ID). */
  let previewCounter = 0;

  function removePreviewAt(index: number): void {
    if (index < 0 || index >= pendingAttachments.length) return;
    const att = pendingAttachments[index]!;
    if (att.progressTimer !== null) {
      clearInterval(att.progressTimer);
      att.progressTimer = null;
    }
    const img = att.previewEl.querySelector("img");
    if (img !== null && img.src.startsWith("blob:")) {
      URL.revokeObjectURL(img.src);
    }
    att.previewEl.remove();
    pendingAttachments.splice(index, 1);
    if (pendingAttachments.length === 0) {
      attachmentPreviewBar?.classList.remove("visible");
    }
    updateSendBtnIcon();
  }

  function removePreviewItem(tempId: string): void {
    removePreviewAt(pendingAttachments.findIndex((a) => a.id === tempId));
  }

  function removePreviewElement(previewEl: HTMLDivElement): void {
    removePreviewAt(pendingAttachments.findIndex((a) => a.previewEl === previewEl));
  }

  /** Read a File as a data: URL (more reliable than createObjectURL in WebView2). */
  function readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(new Error("Failed to read file"));
      reader.readAsDataURL(file);
    });
  }

  async function handlePasteFile(file: File): Promise<void> {
    if (options.onUploadFile === undefined || attachmentPreviewBar === null) return;

    // Validate file size
    if (file.size > MAX_FILE_SIZE) {
      showUploadError(`File too large: ${file.name} exceeds 100 MB limit`);
      return;
    }

    // Validate file type (allow empty type for files without MIME info)
    if (file.type !== "" && !ALLOWED_TYPES.some((t) => file.type.startsWith(t))) {
      showUploadError(`Unsupported file type: ${file.type}`);
      return;
    }

    const tempId = `pending-${++previewCounter}`;
    const isImage = file.type.startsWith("image/");

    attachmentPreviewBar.classList.add("visible");

    const item = createElement("div", { class: "attachment-preview-item uploading" });

    if (isImage) {
      // Read file as data URL for preview (works reliably in WebView2)
      const img = createElement("img", {
        class: "attachment-preview-img",
        alt: file.name,
      });
      item.appendChild(img);
      readFileAsDataUrl(file).then((dataUrl) => {
        img.src = dataUrl;
      }).catch(() => {
        // Fallback: show filename
        const nameEl = createElement("span", { class: "attachment-preview-name" }, file.name);
        img.replaceWith(nameEl);
      });
    } else {
      const icon = createElement("div", { class: "attachment-preview-file" });
      icon.appendChild(createIcon("file-text", 16));
      const nameEl = createElement("span", { class: "attachment-preview-name" }, file.name);
      appendChildren(item, icon, nameEl);
    }

    // Professional upload indicator (shared for file and recorded-voice uploads)
    const uploadIndicator = createElement("div", { class: "attachment-preview-upload-indicator" });
    const uploadLabel = createElement("span", { class: "attachment-preview-upload-label" }, "Загрузка");
    const uploadMeta = createElement(
      "span",
      { class: "attachment-preview-upload-meta" },
      `${formatBytes(file.size)} • осталось ${formatBytes(file.size)}`,
    );
    const uploadTrack = createElement("div", { class: "attachment-preview-upload-track" });
    const uploadBar = createElement("div", { class: "attachment-preview-upload-bar" });
    uploadTrack.appendChild(uploadBar);
    appendChildren(uploadIndicator, uploadLabel, uploadMeta, uploadTrack);
    item.appendChild(uploadIndicator);

    const removeBtn = createElement("button", {
      class: "attachment-preview-remove",
      "data-testid": "attachment-remove",
    });
    removeBtn.appendChild(createIcon("x", 14));
    removeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      removePreviewElement(item);
    }, { signal });
    item.appendChild(removeBtn);

    attachmentPreviewBar.appendChild(item);
    const pendingAttachment = {
      id: tempId,
      filename: file.name,
      previewEl: item,
      uploaded: null as Attachment | null,
      progressTimer: null as ReturnType<typeof setInterval> | null,
    };
    pendingAttachments.push(pendingAttachment);

    // We don't receive low-level upload bytes from Tauri HTTP plugin, so we
    // animate progress smoothly and still show precise total size and remaining estimate.
    const startedAt = Date.now();
    const estimatedDurationMs = Math.max(1100, Math.min(15000, Math.round(file.size / 130)));
    const updateProgress = (): void => {
      if (!item.isConnected) return;
      const elapsed = Date.now() - startedAt;
      const ratio = Math.min(0.93, elapsed / estimatedDurationMs);
      const remaining = Math.max(0, Math.round(file.size * (1 - ratio)));
      uploadBar.style.width = `${Math.max(8, Math.round(ratio * 100))}%`;
      setText(uploadMeta, `${formatBytes(file.size)} • осталось ${formatBytes(remaining)}`);
    };
    updateProgress();
    pendingAttachment.progressTimer = setInterval(updateProgress, 120);

    // Upload in background
    pendingUploadCount++;
    try {
      const result = await options.onUploadFile(file);
      // Replace temp ID with real server ID
      const att = pendingAttachments.find((a) => a.id === tempId);
      if (att !== undefined) {
        if (att.progressTimer !== null) {
          clearInterval(att.progressTimer);
          att.progressTimer = null;
        }
        att.id = result.id;
        att.filename = result.filename;
        att.uploaded = {
          id: result.id,
          filename: result.filename,
          size: file.size,
          mime: file.type === "" ? "application/octet-stream" : file.type,
          url: result.url,
        };
        uploadBar.style.width = "100%";
        setText(uploadMeta, `${formatBytes(file.size)} • осталось 0 B`);
        item.classList.remove("uploading");
        uploadIndicator.remove();
      }
    } catch (err) {
      // Upload failed — remove preview and show error
      removePreviewItem(tempId);
      const errMsg = err instanceof Error ? err.message : "Upload failed";
      showUploadError(`Upload failed: ${errMsg}`);
    } finally {
      pendingUploadCount--;
    }
    updateSendBtnIcon();
  }

  function setReplyTo(messageId: number, username: string): void {
    if (state.editing !== null) hideEditBar();
    state = { replyTo: { messageId, username }, editing: null };
    showReplyBar(username);
    textarea?.focus();
  }

  function clearReply(): void {
    state = { ...state, replyTo: null };
    hideReplyBar();
  }

  function startEdit(messageId: number, content: string): void {
    if (state.replyTo !== null) hideReplyBar();
    state = { replyTo: null, editing: { messageId } };
    showEditBar();
    if (textarea !== null) {
      textarea.value = content;
      autoResize();
      textarea.focus();
    }
  }

  function cancelEdit(): void {
    state = { ...state, editing: null };
    hideEditBar();
    if (textarea !== null) { textarea.value = ""; autoResize(); }
  }

  function mount(container: Element): void {
    root = createElement("div", { class: "message-input-wrap", "data-testid": "message-input" });

    replyBar = createElement("div", { class: "reply-bar" });
    const replyInner = createElement("div", { class: "reply-bar-inner" });
    replyText = createElement("strong", {});
    replyInner.appendChild(replyText);
    const replyClose = createElement("button", { class: "reply-close" });
    replyClose.appendChild(createIcon("x", 14));
    replyClose.addEventListener("click", clearReply, { signal });
    replyInner.appendChild(replyClose);
    replyBar.appendChild(replyInner);

    editBar = createElement("div", { class: "reply-bar" });
    const editInner = createElement("div", { class: "reply-bar-inner" });
    const editText = createElement("strong", {}, "Editing message");
    editInner.appendChild(editText);
    const editClose = createElement("button", { class: "reply-close" });
    editClose.appendChild(createIcon("x", 14));
    editClose.addEventListener("click", () => cancelEdit(), { signal });
    editInner.appendChild(editClose);
    editBar.appendChild(editInner);

    attachmentPreviewBar = createElement("div", { class: "attachment-preview-bar" });

    const inputBox = createElement("div", { class: "message-input-box" });
    const attachBtn = createElement("button",
      { class: "input-btn attach-btn", "aria-label": "Attach file", title: "Attach file" });
    attachBtn.appendChild(createIcon("paperclip", 20));

    // File picker via attach button
    if (options.onUploadFile !== undefined) {
      const fileInput = createElement("input", {
        type: "file",
        style: "display: none;",
        accept: "image/*,video/*,audio/*,.pdf,.txt,.zip,.rar,.7z",
        multiple: "multiple",
      });
      fileInput.addEventListener("change", () => {
        const files = fileInput.files;
        if (files !== null) {
          attachFiles(Array.from(files));
        }
        fileInput.value = "";
      }, { signal });
      attachBtn.addEventListener("click", () => fileInput.click(), { signal });
      root?.appendChild(fileInput);
    } else {
      attachBtn.setAttribute("disabled", "true");
      attachBtn.title = "File uploads not available";
    }
    textarea = createElement("textarea", {
      class: "msg-textarea", placeholder: `Message #${options.channelName}`, rows: "1",
      "data-testid": "msg-textarea",
    });
    const emojiBtn = createElement("button",
      { class: "input-btn emoji-btn", "aria-label": "Emoji" });
    emojiBtn.appendChild(createIcon("smile", 20));
    const gifBtn = createElement("button",
      { class: "input-btn gif-btn", "aria-label": "GIF" }, "GIF");
    sendBtn = createElement("button",
      { class: "input-btn", "aria-label": "Voice message / Send", "data-testid": "send-btn" });
    sendBtn.appendChild(createIcon("mic", 20));

    // Voice recording UI (Premium redesigned)
    inputBox.style.position = "relative";
    recordingOverlay = createElement("div", { class: "recording-ui", style: "display: none;" });
    
    const recordCancel = createElement("button", { class: "record-cancel", title: "Cancel recording" });
    recordCancel.appendChild(createIcon("trash-2", 20));
    recordCancel.addEventListener("click", () => {
      canceled = true;
      mediaRecorder?.stop();
    }, { signal });

    const recordCenter = createElement("div", { class: "record-center" });
    const recordDot = createElement("div", { class: "record-dot" });
    
    const liveWaveform = createElement("div", { class: "record-waveform-live" });
    for (let i = 0; i < 16; i++) {
      const bar = createElement("div", { class: "record-live-bar" }) as HTMLDivElement;
      bar.style.setProperty("--wave-delay", `${(i % 8) * 0.1}s`);
      bar.style.setProperty("--wave-peak", `${0.58 + (i % 5) * 0.08}`);
      liveWaveform.appendChild(bar);
    }

    recordingTimeStr = createElement("span", { class: "record-timer" }, "0:00");
    appendChildren(recordCenter, recordDot, liveWaveform, recordingTimeStr);

    const recordConfirm = createElement("button", { class: "record-confirm", title: "Stop and Send" });
    recordConfirm.appendChild(createIcon("check", 24));
    recordConfirm.addEventListener("click", () => {
      canceled = false;
      mediaRecorder?.stop();
    }, { signal });

    appendChildren(recordingOverlay, recordCancel, recordCenter, recordConfirm);
    inputBox.appendChild(recordingOverlay);

    textarea.addEventListener("input", () => { autoResize(); maybeEmitTyping(); updateSendBtnIcon(); }, { signal });
    textarea.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
      if (e.key === "Escape") {
        if (state.editing !== null) { cancelEdit(); }
        else if (state.replyTo !== null) { clearReply(); }
      }
      if (e.key === "ArrowUp" && textarea !== null && textarea.value.length === 0) {
        root?.dispatchEvent(new CustomEvent("edit-last-message", { bubbles: true }));
      }
    }, { signal });

    // Clipboard paste: detect images/files
    textarea.addEventListener("paste", (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (items === undefined) return;
      const files: File[] = [];
      for (const item of items) {
        if (item.kind !== "file") continue;
        const file = item.getAsFile();
        if (file === null) continue;
        files.push(file);
      }
      if (files.length > 0) {
        e.preventDefault();
        attachFiles(files);
      }
    }, { signal });

    let dragDepth = 0;
    const clearDragState = (): void => {
      dragDepth = 0;
      inputBox.classList.remove("file-drag-over");
    };

    inputBox.addEventListener("dragenter", (e: DragEvent) => {
      if (!hasDraggedFiles(e)) return;
      e.preventDefault();
      dragDepth++;
      inputBox.classList.add("file-drag-over");
    }, { signal });
    inputBox.addEventListener("dragover", (e: DragEvent) => {
      if (!hasDraggedFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer !== null) {
        e.dataTransfer.dropEffect = "copy";
      }
      inputBox.classList.add("file-drag-over");
    }, { signal });
    inputBox.addEventListener("dragleave", (e: DragEvent) => {
      if (!hasDraggedFiles(e)) return;
      e.preventDefault();
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) {
        inputBox.classList.remove("file-drag-over");
      }
    }, { signal });
    inputBox.addEventListener("drop", (e: DragEvent) => {
      if (!hasDraggedFiles(e)) return;
      e.preventDefault();
      const files = Array.from(e.dataTransfer?.files ?? []);
      clearDragState();
      attachFiles(files);
    }, { signal });
    window.addEventListener("dragend", clearDragState, { signal });

    async function startRecording() {
      if (options.onUploadFile === undefined) return;
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRecorder = new MediaRecorder(stream);
        audioChunks = [];
        mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
        mediaRecorder.onstop = () => {
          if (recordInterval !== null) clearInterval(recordInterval);
          if (recordingOverlay !== null) recordingOverlay.style.display = "none";
          stream.getTracks().forEach(t => t.stop());
          
          if (!canceled && audioChunks.length > 0) {
            const blob = new Blob(audioChunks, { type: "audio/webm" });
            const file = new File([blob], `Voice message.webm`, { type: "audio/webm" });
            handlePasteFile(file).then(() => {
              if (textarea !== null && textarea.value.trim().length === 0) {
                handleSend();
              }
            }).catch(console.error);
          }
          isRecording = false;
        };
        
        mediaRecorder.start();
        isRecording = true;
        canceled = false;
        recordStartTime = Date.now();
        
        if (recordingOverlay !== null) {
          recordingOverlay.style.display = "flex";
        }
        if (recordingTimeStr !== null) recordingTimeStr.textContent = "0:00";
        recordInterval = setInterval(() => {
          const s = Math.floor((Date.now() - recordStartTime) / 1000);
          const m = Math.floor(s / 60);
          const sec = s % 60;
          if (recordingTimeStr !== null) recordingTimeStr.textContent = `${m}:${sec.toString().padStart(2, "0")}`;
        }, 250);

      } catch (err) {
        console.error("Mic error", err);
      }
    }

    sendBtn.addEventListener("click", (e: MouseEvent) => {
      if (micMode) {
        e.preventDefault();
        if (!isRecording) {
          void startRecording();
        } else {
          // If already recording, clicking the mic button also stops and sends
          canceled = false;
          mediaRecorder?.stop();
        }
      } else {
        handleSend();
      }
    }, { signal });

    // Picker state (declared together so both toggle functions can cross-close)
    let emojiPicker: { element: HTMLDivElement; destroy(): void } | null = null;
    let gifPicker: { element: HTMLDivElement; destroy(): void } | null = null;

    function closeEmojiPicker(): void {
      if (emojiPicker !== null) {
        emojiPicker.element.remove();
        emojiPicker.destroy();
        emojiPicker = null;
        document.removeEventListener("mousedown", handleClickOutside);
      }
    }

    function handleClickOutside(e: MouseEvent): void {
      if (emojiPicker === null) return;
      const target = e.target as Node;
      // Close if click is outside both the picker and the emoji button
      if (!emojiPicker.element.contains(target) && target !== emojiBtn && !emojiBtn.contains(target)) {
        closeEmojiPicker();
      }
    }

    function toggleEmojiPicker(): void {
      // Close GIF picker if open
      if (gifPicker !== null) {
        closeGifPicker();
      }
      if (emojiPicker !== null) {
        closeEmojiPicker();
        return;
      }
      emojiPicker = createEmojiPicker({
        onSelect: (emoji: string) => {
          if (textarea !== null) {
            const start = textarea.selectionStart;
            const end = textarea.selectionEnd;
            const before = textarea.value.slice(0, start);
            const after = textarea.value.slice(end);
            textarea.value = before + emoji + after;
            textarea.selectionStart = textarea.selectionEnd = start + emoji.length;
            textarea.focus();
          }
          closeEmojiPicker();
        },
        onClose: () => {
          closeEmojiPicker();
        },
      });
      root?.appendChild(emojiPicker.element);
      // Defer so this click doesn't immediately close it
      const t1 = setTimeout(() => {
        activeTimers.delete(t1);
        document.addEventListener("mousedown", handleClickOutside);
      }, 0);
      activeTimers.add(t1);
    }

    emojiBtn.addEventListener("click", toggleEmojiPicker, { signal });

    // GIF picker toggle
    function closeGifPicker(): void {
      if (gifPicker !== null) {
        gifPicker.element.remove();
        gifPicker.destroy();
        gifPicker = null;
        document.removeEventListener("mousedown", handleGifClickOutside);
      }
    }

    function handleGifClickOutside(e: MouseEvent): void {
      if (gifPicker === null) return;
      const target = e.target as Node;
      if (!gifPicker.element.contains(target) && target !== gifBtn && !gifBtn.contains(target)) {
        closeGifPicker();
      }
    }

    function toggleGifPicker(): void {
      // Close emoji picker if open
      if (emojiPicker !== null) {
        closeEmojiPicker();
      }
      if (gifPicker !== null) {
        closeGifPicker();
        return;
      }
      gifPicker = createGifPicker({
        onSelect: (gifUrl: string) => {
          if (textarea !== null) {
            textarea.value = gifUrl;
            handleSend();
          }
          closeGifPicker();
        },
        onClose: () => {
          closeGifPicker();
        },
      });
      root?.appendChild(gifPicker.element);
      const t2 = setTimeout(() => {
        activeTimers.delete(t2);
        document.addEventListener("mousedown", handleGifClickOutside);
      }, 0);
      activeTimers.add(t2);
    }

    gifBtn.addEventListener("click", toggleGifPicker, { signal });

    // Store picker cleanup for destroy()
    cleanupPickers = () => { closeEmojiPicker(); closeGifPicker(); };

    appendChildren(inputBox, attachBtn, textarea, emojiBtn, gifBtn, sendBtn);
    appendChildren(root, replyBar, editBar, attachmentPreviewBar, inputBox);
    container.appendChild(root);
    textarea.focus();
  }

  function destroy(): void {
    // Close any open pickers and their document listeners before aborting
    cleanupPickers?.();
    cleanupPickers = null;
    // Clear all pending timers
    for (const t of activeTimers) clearTimeout(t);
    activeTimers.clear();
    ac.abort();
    for (const att of pendingAttachments) {
      if (att.progressTimer !== null) {
        clearInterval(att.progressTimer);
        att.progressTimer = null;
      }
    }
    // Image previews use data: URLs (via readFileAsDataUrl) and don't need URL.revokeObjectURL.
    pendingAttachments.length = 0;
    root?.remove();
    root = null;
    textarea = null;
    replyBar = null;
    replyText = null;
    editBar = null;
    attachmentPreviewBar = null;
  }

  return { mount, destroy, setReplyTo, clearReply, startEdit, cancelEdit };
}
