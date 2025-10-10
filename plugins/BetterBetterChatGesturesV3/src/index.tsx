import { findByProps, findByStoreName } from "@vendetta/metro";
import { ReactNative } from "@vendetta/metro/common";
import { after, instead, before } from "@vendetta/patcher";
import { storage, manifest } from "@vendetta/plugin";
import Settings from "./components/Settings";
import { DefaultNativeEvent, DoubleTapStateProps, Plugin } from "./def";
import { logger } from "@vendetta";

// Modules utiles
const ChatInputRef = findByProps("insertText");
const ChannelStore = findByStoreName("ChannelStore");
const MessageStore = findByStoreName("MessageStore");
const UserStore = findByStoreName("UserStore");
const Messages = findByProps("sendMessage", "startEditMessage");
const ReplyManager = findByProps("createPendingReply");

// Récupération de MessagesHandlers
let MessagesHandlersModule;
try {
  MessagesHandlersModule = findByProps("MessagesHandlers");
} catch (e) {
  logger.warn("BetterChatGestures: Cannot find MessagesHandlers via findByProps");
}
if (!MessagesHandlersModule) {
  const allModules = window.vendetta?.metro?.cache || new Map();
  for (const [key, module] of allModules) {
    if (module?.exports?.MessagesHandlers) {
      MessagesHandlersModule = module.exports;
      logger.log("BetterChatGestures: Found MessagesHandlers in cache iteration");
      break;
    }
  }
}
const MessagesHandlers = MessagesHandlersModule?.MessagesHandlers;

const BetterChatGestures: Plugin = {
  unpatchGetter: null,
  unpatchHandlers: null,
  currentTapIndex: 0,
  currentMessageID: null,
  timeoutTap: null,
  patches: [] as (() => void)[],
  handlersInstances: new WeakSet(),

  doubleTapState({ state = "UNKNOWN", nativeEvent }: DoubleTapStateProps) {
    try {
      const stateObject: any = { state, data: nativeEvent };
      if (state === "INCOMPLETE" && nativeEvent) {
        Object.assign(stateObject, {
          reason: {
            required: { taps: 2, isAuthor: true },
            received: { taps: nativeEvent.taps, isAuthor: nativeEvent.isAuthor },
          },
        });
      }
      const currentUser = UserStore?.getCurrentUser();
      if (currentUser && manifest.authors.find(a => a.id === currentUser.id)) {
        console.log("DoubleTapState", stateObject);
      }
    } catch (e) {
      logger.error("BetterChatGestures: Error in doubleTapState", e);
    }
  },

  resetTapState() {
    if (this.timeoutTap) {
      clearTimeout(this.timeoutTap);
      this.timeoutTap = null;
    }
    this.currentTapIndex = 0;
    this.currentMessageID = null;
  },

  openKeyboard() {
    if (!storage.keyboardPopup) return;
    try {
      const keyboardModule = findByProps("openSystemKeyboard");
      if (keyboardModule?.openSystemKeyboard) {
        keyboardModule.openSystemKeyboard();
        return;
      }
      if (keyboardModule?.openSystemKeyboardForLastCreatedInput) {
        keyboardModule.openSystemKeyboardForLastCreatedInput();
        return;
      }
      const ChatInput = ChatInputRef?.refs?.[0]?.current;
      if (ChatInput?.focus) {
        ChatInput.focus();
        return;
      }
      if (ReactNative.Keyboard?.dismiss) {
        setTimeout(() => {
          if (ChatInput?.focus) {
            ChatInput.focus();
          }
        }, 50);
      }
    } catch (e) {
      if (storage.debugMode) {
        logger.error("BetterChatGestures: Error in openKeyboard", e);
      }
    }
  },

  patchHandlers(handlers: any) {
    if (this.handlersInstances.has(handlers)) return;
    this.handlersInstances.add(handlers);

    try {
      // Patch rapide double tap
      if (handlers.handleDoubleTapMessage) {
        const p = instead("handleDoubleTapMessage", handlers, (args, orig) => {
          try {
            const evt0 = args?.[0];
            if (!evt0?.nativeEvent) return orig.apply(handlers, args);
            const { nativeEvent } = evt0;
            const c = nativeEvent.channelId;
            const m = nativeEvent.messageId;
            if (!c || !m) return orig.apply(handlers, args);
            const msg = MessageStore?.getMessage(c, m);
            if (!msg) return orig.apply(handlers, args);
            const currentUser = UserStore?.getCurrentUser();
            const isAuthor = currentUser && msg.author ? msg.author.id === currentUser.id : false;
            if (isAuthor && storage.userEdit) {
              Messages?.startEditMessage(c, m, msg.content || "");
            } else if (storage.reply) {
              const ch = ChannelStore.getChannel(c);
              if (ch) ReplyManager?.createPendingReply({ channel: ch, message: msg, shouldMention: true });
            }
            this.openKeyboard();
            return;
          } catch (e) {
            logger.error("BetterChatGestures: Error in patched handleDoubleTapMessage", e);
            return orig.apply(handlers, args);
          }
        });
        this.patches.push(p);
      }

      // Patch tap username
      if (handlers.handleTapUsername && storage.tapUsernameMention) {
        const p = instead("handleTapUsername", handlers, (args, orig) => {
          try {
            const evt0 = args?.[0];
            if (!evt0?.nativeEvent) return orig.apply(handlers, args);
            const ChatInput = ChatInputRef?.refs?.[0]?.current;
            if (!ChatInput?.props?.channel?.id) return orig.apply(handlers, args);
            const msg = MessageStore.getMessage(ChatInput.props.channel.id, evt0.nativeEvent.messageId);
            if (!msg?.author) return orig.apply(handlers, args);
            const disc = msg.author.discriminator !== "0" ? `#${msg.author.discriminator}` : "";
            ChatInputRef.insertText(`@${msg.author.username}${disc}`);
          } catch (e) {
            logger.error("BetterChatGestures: Error in patched handleTapUsername", e);
            return orig.apply(handlers, args);
          }
        });
        this.patches.push(p);
      }

      // Patch tap message (lent double tap)
      if (handlers.handleTapMessage) {
        const p = instead("handleTapMessage", handlers, (args, orig) => {
          try {
            const evt0 = args?.[0];
            if (!evt0?.nativeEvent) return orig.apply(handlers, args);
            const ne = evt0.nativeEvent as DefaultNativeEvent;
            const c = ne.channelId;
            const m = ne.messageId;
            if (!c || !m) return orig.apply(handlers, args);
            const msg = MessageStore.getMessage(c, m);
            if (!msg) return orig.apply(handlers, args);
            const currentUser = UserStore?.getCurrentUser();
            const isAuthor = currentUser && msg.author ? msg.author.id === currentUser.id : false;

            if (this.currentMessageID === m) {
              this.currentTapIndex++;
            } else {
              this.resetTapState();
              this.currentTapIndex = 1;
              this.currentMessageID = m;
            }

            let delayMs = 1000;
            if (storage.delay) {
              const pd = parseInt(storage.delay, 10);
              if (!isNaN(pd) && pd >= 200) delayMs = pd;
            }
            if (this.timeoutTap) clearTimeout(this.timeoutTap);
            this.timeoutTap = setTimeout(() => this.resetTapState(), delayMs);

            const enriched = {
              ...ne,
              taps: this.currentTapIndex,
              content: msg.content || "",
              authorId: msg.author?.id,
              isAuthor
            };

            if (this.currentTapIndex !== 2) {
              this.doubleTapState({ state: "INCOMPLETE", nativeEvent: enriched });
              return;
            }

            this.resetTapState();
            if (isAuthor && storage.userEdit) {
              Messages?.startEditMessage(c, m, enriched.content);
            } else if (storage.reply) {
              const ch = ChannelStore.getChannel(c);
              if (ch) ReplyManager?.createPendingReply({ channel: ch, message: msg, shouldMention: true });
            }
            this.openKeyboard();
            this.doubleTapState({ state: "COMPLETE", nativeEvent: enriched });
            return;
          } catch (e) {
            logger.error("BetterChatGestures: Error in patched handleTapMessage", e);
            return orig.apply(handlers, args);
          }
        });
        this.patches.push(p);
      }

      this.unpatchHandlers = () => {
        this.patches.forEach(u => {
          try { u(); } catch (_) { }
        });
        this.patches = [];
        this.handlersInstances = new WeakSet();
      };
    } catch (e) {
      logger.error("BetterChatGestures: Error in patchHandlers", e);
    }
  },

  onLoad() {
    if (!MessagesHandlers) {
      logger.error("BetterChatGestures: MessagesHandlers not found — plugin may not function fully");
    }

    storage.tapUsernameMention ??= ReactNative.Platform.select({ android: false, ios: true, default: true });
    if (ReactNative.Platform.OS === "android") storage.tapUsernameMention = false;
    storage.reply ??= true;
    storage.userEdit ??= true;
    storage.keyboardPopup ??= true;
    storage.delay ??= "1000";
    storage.debugMode ??= true;
    if (!storage.delay || isNaN(parseInt(storage.delay, 10)) || parseInt(storage.delay, 10) < 200) {
      storage.delay = "1000";
    }

    logger.log("BetterChatGestures: init, delay =", storage.delay);

    const self = this;
    const propNames = ["params", "handlers", "_params", "messageHandlers"];
    let origGetter: any = null;
    let usedProp: string | null = null;
    for (const pn of propNames) {
      origGetter = Object.getOwnPropertyDescriptor(MessagesHandlers?.prototype || {}, pn)?.get;
      if (origGetter) {
        usedProp = pn;
        logger.log("BetterChatGestures: Found getter prop", pn);
        break;
      }
    }
    if (origGetter && usedProp) {
      Object.defineProperty(MessagesHandlers.prototype, usedProp, {
        configurable: true,
        get() {
          if (this) self.patchHandlers.call(self, this);
          return origGetter.call(this);
        }
      });

      // Forcer patch sur instance existante
      const allMods = window.vendetta?.metro?.cache || new Map();
      for (const [k, mod] of allMods) {
        try {
          if (mod?.exports) {
            for (const exKey in mod.exports) {
              const ex = mod.exports[exKey];
              if (ex?.prototype === MessagesHandlers.prototype || ex instanceof MessagesHandlers) {
                const handlers = (ex as any)[usedProp];
                if (handlers) {
                  self.patchHandlers.call(self, handlers);
                  logger.log("BetterChatGestures: Patched existing handlers instance on load");
                }
              }
            }
          }
        } catch {}
      }

      this.unpatchGetter = () => {
        if (origGetter && usedProp) {
          Object.defineProperty(MessagesHandlers.prototype, usedProp, {
            configurable: true,
            get: origGetter
          });
        }
      };
    } else {
      logger.warn("BetterChatGestures: Could not find MessagesHandlers getter");
    }

    // —— Partie de debugging : log des fonctions de réaction possibles ———
    try {
      const allMods = window.vendetta?.metro?.cache || new Map();
      for (const [key, mod] of allMods) {
        if (!mod?.exports) continue;
        for (const fnName in mod.exports) {
          const val = (mod.exports as any)[fnName];
          if (typeof val === "function") {
            const name = fnName.toLowerCase();
            if (
              name.includes("reaction") ||
              name.includes("react") ||
              name.includes("toggle") ||
              name.includes("add") && name.includes("react")
            ) {
              // logger une trace de ceux potentiels
              logger.log(`BetterChatGestures: found candidate reaction fn: ${fnName}`, val);
            }
          }
        }
      }
    } catch (e) {
      logger.error("BetterChatGestures: error logging reaction candidates", e);
    }
  },

  onUnload() {
    this.resetTapState();
    if (this.unpatchGetter) this.unpatchGetter();
    if (this.unpatchHandlers) this.unpatchHandlers();
    this.patches.forEach(p => {
      try {
        p();
      } catch {}
    });
    this.patches = [];
  },

  settings: Settings
};

export default BetterChatGestures;
