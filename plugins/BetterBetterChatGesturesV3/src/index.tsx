import { findByProps, findByStoreName } from "@vendetta/metro";
import { ReactNative } from "@vendetta/metro/common";
import { after, before, instead } from "@vendetta/patcher";
import { storage, manifest } from "@vendetta/plugin";
import Settings from "./components/Settings";
import { DefaultNativeEvent, DoubleTapStateProps, Plugin } from "./def";
import { findInReactTree } from "@vendetta/utils";
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
  logger.warn("BetterChatGestures: Could not find MessagesHandlers via findByProps");
}
if (!MessagesHandlersModule) {
  try {
    const allModules = window.vendetta?.metro?.cache || new Map();
    for (const [key, module] of allModules) {
      if (module?.exports?.MessagesHandlers) {
        MessagesHandlersModule = module.exports;
        logger.log("BetterChatGestures: Found MessagesHandlers via cache iteration");
        break;
      }
    }
  } catch (e) {
    logger.error("BetterChatGestures: Failed to find MessagesHandlers via cache", e);
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
      const stateObject: any = {
        state,
        data: nativeEvent,
      };
      if (state === "INCOMPLETE" && nativeEvent) {
        Object.assign(stateObject, {
          reason: {
            required: {
              taps: 2,
              isAuthor: true,
            },
            received: {
              taps: nativeEvent.taps,
              isAuthor: nativeEvent.isAuthor,
            },
          },
        });
      }
      const currentUser = UserStore?.getCurrentUser();
      if (currentUser && manifest.authors.find(a => a.id === currentUser.id)) {
        console.log("DoubleTapState", stateObject);
      }
    } catch (error) {
      logger.error("BetterChatGestures: Error in doubleTapState", error);
    }
  },

  resetTapState() {
    try {
      if (this.timeoutTap) {
        clearTimeout(this.timeoutTap);
        this.timeoutTap = null;
      }
      this.currentTapIndex = 0;
      this.currentMessageID = null;
    } catch (error) {
      logger.error("BetterChatGestures: Error in resetTapState", error);
    }
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
    } catch (error) {
      if (storage.debugMode) {
        logger.error("BetterChatGestures: Error opening keyboard", error);
      }
    }
  },

  patchHandlers(handlers: any) {
    if (this.handlersInstances.has(handlers)) return;
    this.handlersInstances.add(handlers);

    try {
      // 1. Patch handleDoubleTapMessage (double tap rapide)
      if (handlers.handleDoubleTapMessage) {
        const doubleTapPatch = instead("handleDoubleTapMessage", handlers, (args, orig) => {
          try {
            const evt0 = args?.[0];
            if (!evt0?.nativeEvent) return orig.apply(handlers, args);

            const { nativeEvent } = evt0;
            const ChannelID = nativeEvent.channelId;
            const MessageID = nativeEvent.messageId;
            if (!ChannelID || !MessageID) return orig.apply(handlers, args);

            const message = MessageStore?.getMessage(ChannelID, MessageID);
            if (!message) return orig.apply(handlers, args);

            const currentUser = UserStore?.getCurrentUser();
            const isAuthor = currentUser && message.author ? message.author.id === currentUser.id : false;

            // On fait la logique custom
            if (isAuthor && storage.userEdit) {
              Messages?.startEditMessage(ChannelID, MessageID, message.content || "");
            } else if (storage.reply) {
              const channel = ChannelStore.getChannel(ChannelID);
              if (channel) {
                ReplyManager?.createPendingReply({ channel, message, shouldMention: true });
              }
            }
            this.openKeyboard();

            // On bloque le handler d’origine — ne pas appeler orig
            return;
          } catch (error) {
            logger.error("BetterChatGestures: Error in handleDoubleTapMessage patch", error);
            return orig.apply(handlers, args);
          }
        });
        this.patches.push(doubleTapPatch);
      }

      // 2. Patch handleTapUsername si activé
      if (handlers.handleTapUsername && storage.tapUsernameMention) {
        const tapUsernamePatch = instead("handleTapUsername", handlers, (args, orig) => {
          try {
            if (!storage.tapUsernameMention) return orig.apply(handlers, args);
            const evt0 = args?.[0];
            if (!evt0?.nativeEvent) return orig.apply(handlers, args);

            const ChatInput = ChatInputRef?.refs?.[0]?.current;
            if (!ChatInput?.props?.channel?.id) return orig.apply(handlers, args);

            const message = MessageStore.getMessage(
              ChatInput.props.channel.id,
              evt0.nativeEvent.messageId
            );
            if (!message?.author) return orig.apply(handlers, args);

            const discriminatorText = message.author.discriminator !== "0"
              ? `#${message.author.discriminator}`
              : "";
            ChatInputRef.insertText(`@${message.author.username}${discriminatorText}`);
          } catch (error) {
            logger.error("BetterChatGestures: Error in handleTapUsername patch", error);
            return orig.apply(handlers, args);
          }
        });
        this.patches.push(tapUsernamePatch);
      }

      // 3. Patch handleTapMessage pour double tap lent / custom
      if (handlers.handleTapMessage) {
        // On remplace *instead* au lieu de after pour bloquer le comportement natif initial
        const tapMessagePatch = instead("handleTapMessage", handlers, (args, orig) => {
          try {
            const evt0 = args?.[0];
            if (!evt0?.nativeEvent) {
              return orig.apply(handlers, args);
            }
            const { nativeEvent }: { nativeEvent: DefaultNativeEvent } = evt0;
            const ChannelID = nativeEvent.channelId;
            const MessageID = nativeEvent.messageId;
            if (!ChannelID || !MessageID) {
              return orig.apply(handlers, args);
            }
            const message = MessageStore.getMessage(ChannelID, MessageID);
            if (!message) {
              return orig.apply(handlers, args);
            }
            const currentUser = UserStore.getCurrentUser();
            const isAuthor = currentUser && message.author
              ? message.author.id === currentUser.id
              : false;

            // Gérer le compteur de taps
            if (this.currentMessageID === MessageID) {
              this.currentTapIndex++;
            } else {
              this.resetTapState();
              this.currentTapIndex = 1;
              this.currentMessageID = MessageID;
            }

            // Timeout pour remettre à zéro
            let delayMs = 1000;
            if (storage.delay) {
              const parsedDelay = parseInt(storage.delay, 10);
              if (!isNaN(parsedDelay) && parsedDelay >= 200) {
                delayMs = parsedDelay;
              }
            }
            if (this.timeoutTap) {
              clearTimeout(this.timeoutTap);
            }
            this.timeoutTap = setTimeout(() => {
              this.resetTapState();
            }, delayMs);

            const enrichedNativeEvent = {
              ...nativeEvent,
              taps: this.currentTapIndex,
              content: message.content || "",
              authorId: message.author?.id,
              isAuthor,
            };

            if (this.currentTapIndex !== 2) {
              this.doubleTapState({
                state: "INCOMPLETE",
                nativeEvent: enrichedNativeEvent,
              });
              // Ne pas appeler orig pour ce premier tap / double tap partiel
              return;
            }

            // Si double tap (taps === 2)
            const thisMessageID = this.currentMessageID;
            this.resetTapState();

            if (isAuthor && storage.userEdit) {
              Messages?.startEditMessage(ChannelID, thisMessageID!, enrichedNativeEvent.content);
            } else if (storage.reply) {
              const channel = ChannelStore.getChannel(ChannelID);
              if (channel) {
                ReplyManager?.createPendingReply({ channel, message, shouldMention: true });
              }
            }
            this.openKeyboard();
            this.doubleTapState({
              state: "COMPLETE",
              nativeEvent: enrichedNativeEvent,
            });

            // Bloquer l’appel natif (ne pas appeler orig), car on a géré tout
            return;
          } catch (error) {
            logger.error("BetterChatGestures: Error in replaced handleTapMessage", error);
            // En cas d’erreur, fallback : appeler le handler d’origine
            return orig.apply(handlers, args);
          }
        });
        this.patches.push(tapMessagePatch);
      }

      this.unpatchHandlers = () => {
        try {
          this.patches.forEach(p => {
            if (typeof p === "function") p();
          });
          this.patches = [];
          this.handlersInstances = new WeakSet();
        } catch (error) {
          logger.error("BetterChatGestures: Error in unpatchHandlers", error);
        }
      };
    } catch (error) {
      logger.error("BetterChatGestures: Error in patchHandlers", error);
    }
  },

  onLoad() {
    try {
      if (!MessagesHandlers) {
        logger.error("BetterChatGestures: MessagesHandlers module not found! Plugin may not work.");
        return;
      }

      storage.tapUsernameMention ??= ReactNative.Platform.select({
        android: false,
        ios: true,
        default: true,
      });
      if (ReactNative.Platform.OS === "android") {
        storage.tapUsernameMention = false;
      }
      storage.reply ??= true;
      storage.userEdit ??= true;
      storage.keyboardPopup ??= true;
      storage.delay ??= "1000";
      storage.debugMode ??= false;

      if (
        !storage.delay ||
        storage.delay === "" ||
        isNaN(parseInt(storage.delay, 10)) ||
        parseInt(storage.delay, 10) < 200
      ) {
        storage.delay = "1000";
      }

      logger.log("BetterChatGestures: initialized with delay =", storage.delay);

      const self = this;
      const possiblePropertyNames = ["params", "handlers", "_params", "messageHandlers"];
      let origGetParams = null;
      let usedPropertyName: string | null = null;

      for (const propName of possiblePropertyNames) {
        origGetParams = Object.getOwnPropertyDescriptor(
          MessagesHandlers.prototype,
          propName
        )?.get;
        if (origGetParams) {
          usedPropertyName = propName;
          logger.log(`BetterChatGestures: Found property '${propName}'`);
          break;
        }
      }

      if (origGetParams && usedPropertyName) {
        Object.defineProperty(MessagesHandlers.prototype, usedPropertyName, {
          configurable: true,
          get() {
            if (this) self.patchHandlers.call(self, this);
            return origGetParams.call(this);
          },
        });

        // Forcer le patch immédiat si une instance existe
        try {
          const allModules = window.vendetta?.metro?.cache || new Map();
          let foundInstance = false;
          for (const [key, module] of allModules) {
            try {
              if (module?.exports && typeof module.exports === "object") {
                for (const exportKey in module.exports) {
                  const exported = module.exports[exportKey];
                  if (
                    exported?.prototype === MessagesHandlers.prototype ||
                    exported instanceof MessagesHandlers
                  ) {
                    const handlersObj = (exported as any)[usedPropertyName];
                    if (handlersObj) {
                      self.patchHandlers.call(self, handlersObj);
                      logger.log("BetterChatGestures: Patched existing instance on load");
                      foundInstance = true;
                      break;
                    }
                  }
                }
              }
              if (foundInstance) break;
            } catch (e) {
              // skip
            }
          }
          if (!foundInstance) {
            logger.log("BetterChatGestures: No existing instance found at load");
          }
        } catch (error) {
          logger.warn("BetterChatGestures: Could not search for existing instance", error);
        }

        this.unpatchGetter = () => {
          try {
            if (origGetParams && usedPropertyName) {
              Object.defineProperty(MessagesHandlers.prototype, usedPropertyName, {
                configurable: true,
                get: origGetParams,
              });
            }
          } catch (error) {
            logger.error("BetterChatGestures: Error in unpatchGetter", error);
          }
        };
      } else {
        logger.error("BetterChatGestures: Could not find params/handlers getter!");
      }
    } catch (error) {
      logger.error("BetterChatGestures: Error in onLoad", error);
    }
  },

  onUnload() {
    try {
      this.resetTapState();
      if (this.unpatchGetter) this.unpatchGetter();
      if (this.unpatchHandlers) this.unpatchHandlers();
      if (this.timeoutTap) {
        clearTimeout(this.timeoutTap);
        this.timeoutTap = null;
      }
    } catch (error) {
      logger.error("BetterChatGestures: Error in onUnload", error);
    }
  },

  settings: Settings,
};

export default BetterChatGestures;
