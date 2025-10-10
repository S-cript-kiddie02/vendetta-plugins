import { findByProps, findByStoreName } from "@vendetta/metro";
import { ReactNative } from "@vendetta/metro/common";
import { after, before, instead } from "@vendetta/patcher";
import { storage, manifest } from "@vendetta/plugin";
import Settings from "./components/Settings";
import { DefaultNativeEvent, DoubleTapStateProps, Plugin, NativeEvent } from "./def";
import { findInReactTree } from "@vendetta/utils";
import { logger } from "@vendetta";

// Modules Discord
const ChatInputRef = findByProps("insertText");
const ChannelStore = findByStoreName("ChannelStore");
const MessageStore = findByStoreName("MessageStore");
const UserStore = findByStoreName("UserStore");
const Messages = findByProps("sendMessage", "startEditMessage");
const ReplyManager = findByProps("createPendingReply");

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
    patches: [],
    handlersInstances: new WeakSet(),

    doubleTapState({ state = "UNKNOWN", nativeEvent }: DoubleTapStateProps) {
        try {
            const stateObject = { state, data: nativeEvent };
            if (state === "INCOMPLETE" && nativeEvent) {
                Object.assign(stateObject, {
                    reason: {
                        required: { taps: 2, isAuthor: true },
                        received: { taps: nativeEvent.taps, isAuthor: nativeEvent.isAuthor }
                    }
                });
            }
            const currentUser = UserStore?.getCurrentUser();
            if (currentUser && manifest.authors.find(author => author.id === currentUser.id)) {
                console.log("DoubleTapState", stateObject);
            }
        } catch (error) {
            logger.error("BetterChatGestures: Error in doubleTapState", error);
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
        } catch (error) {
            if (storage.debugMode) {
                logger.error("BetterChatGestures: Error opening keyboard", error);
            }
        }
    },

    patchHandlers(handlers) {
        if (this.handlersInstances.has(handlers)) return;
        this.handlersInstances.add(handlers);

        try {
            if (handlers.handleDoubleTapMessage) {
                const doubleTapPatch = instead("handleDoubleTapMessage", handlers, (args, orig) => {
                    try {
                        if (!args?.[0]?.nativeEvent) return;
                        const { nativeEvent } = args[0];
                        const ChannelID = nativeEvent.channelId;
                        const MessageID = nativeEvent.messageId;
                        if (!ChannelID || !MessageID) return;
                        const channel = ChannelStore?.getChannel(ChannelID);
                        const message = MessageStore?.getMessage(ChannelID, MessageID);
                        if (!message) return;
                        const currentUser = UserStore?.getCurrentUser();
                        const isAuthor = currentUser && message.author ? message.author.id === currentUser.id : false;
                        if (isAuthor && storage.userEdit) {
                            Messages?.startEditMessage(ChannelID, MessageID, message.content || '');
                        } else if (storage.reply && channel) {
                            ReplyManager?.createPendingReply({ channel, message, shouldMention: true });
                        }
                        this.openKeyboard();
                        return;
                    } catch (error) {
                        logger.error("BetterChatGestures: Error in handleDoubleTapMessage patch", error);
                    }
                });
                this.patches.push(doubleTapPatch);
            }

            if (handlers.handleTapUsername && storage.tapUsernameMention) {
                const tapUsernamePatch = instead("handleTapUsername", handlers, (args, orig) => {
                    try {
                        if (!storage.tapUsernameMention) return orig.apply(handlers, args);
                        if (!args?.[0]?.nativeEvent) return orig.apply(handlers, args);

                        const ChatInput = ChatInputRef?.refs?.[0]?.current;
                        const { messageId } = args[0].nativeEvent;
                        if (!ChatInput?.props?.channel?.id) return orig.apply(handlers, args);

                        const message = MessageStore.getMessage(ChatInput.props.channel.id, messageId);
                        if (!message?.author) return orig.apply(handlers, args);

                        const discriminatorText = message.author.discriminator !== "0" ? `#${message.author.discriminator}` : '';
                        ChatInputRef.insertText(`@${message.author.username}${discriminatorText}`);
                    } catch (error) {
                        logger.error("BetterChatGestures: Error in handleTapUsername patch", error);
                        return orig.apply(handlers, args);
                    }
                });
                this.patches.push(tapUsernamePatch);
            }

            if (handlers.handleTapMessage) {
                const tapMessagePatch = after("handleTapMessage", handlers, (args) => {
                    try {
                        if (!args?.[0]) return;
                        const { nativeEvent }: { nativeEvent: DefaultNativeEvent } = args[0];
                        if (!nativeEvent) return;

                        const ChannelID = nativeEvent.channelId;
                        const MessageID = nativeEvent.messageId;
                        if (!ChannelID || !MessageID) return;

                        const channel = ChannelStore?.getChannel(ChannelID);
                        const message = MessageStore?.getMessage(ChannelID, MessageID);
                        if (!message) return;

                        if (this.currentMessageID === MessageID) {
                            this.currentTapIndex++;
                        } else {
                            this.resetTapState();
                            this.currentTapIndex = 1;
                            this.currentMessageID = MessageID;
                        }

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

                        const currentUser = UserStore?.getCurrentUser();
                        const isAuthor = currentUser && message.author ? message.author.id === currentUser.id : false;

                        const enrichedNativeEvent = {
                            ...nativeEvent,
                            taps: this.currentTapIndex,
                            content: message.content || '',
                            authorId: message.author?.id,
                            isAuthor
                        };

                        if (this.currentTapIndex !== 2) {
                            this.doubleTapState({ state: "INCOMPLETE", nativeEvent: enrichedNativeEvent });
                            return;
                        }

                        this.resetTapState();

                        if (isAuthor && storage.userEdit) {
                            Messages?.startEditMessage(ChannelID, MessageID, enrichedNativeEvent.content);
                        } else if (storage.reply && channel) {
                            ReplyManager?.createPendingReply({ channel, message, shouldMention: true });
                        }

                        this.openKeyboard();

                        this.doubleTapState({ state: "COMPLETE", nativeEvent: enrichedNativeEvent });
                    } catch (error) {
                        logger.error("BetterChatGestures: Error in handleTapMessage patch", error);
                        this.resetTapState();
                    }
                });
                this.patches.push(tapMessagePatch);
            }

            this.unpatchHandlers = () => {
                this.patches.forEach(unpatch => typeof unpatch === 'function' && unpatch());
                this.patches = [];
                this.handlersInstances = new WeakSet();
            };
        } catch (error) {
            logger.error("BetterChatGestures: Error in patchHandlers", error);
        }
    },

    onLoad() {
        if (!MessagesHandlers) {
            logger.error("BetterChatGestures: MessagesHandlers module not found! Plugin will not work.");
            return;
        }

        storage.tapUsernameMention ??= ReactNative.Platform.select({ android: false, ios: true, default: true });
        if (ReactNative.Platform.OS === 'android') storage.tapUsernameMention = false;
        storage.reply ??= true;
        storage.userEdit ??= true;
        storage.keyboardPopup ??= true;
        storage.delay ??= "1000";
        storage.debugMode ??= false;
        if (!storage.delay || isNaN(parseInt(storage.delay, 10)) || parseInt(storage.delay, 10) < 200) {
            storage.delay = "1000";
        }

        logger.log("BetterChatGestures: initialized with delay =", storage.delay);

        const self = this;
        const possiblePropertyNames = ["params", "handlers", "_params", "messageHandlers"];
        let origGetParams = null;
        let usedPropertyName = null;

        for (const propName of possiblePropertyNames) {
            origGetParams = Object.getOwnPropertyDescriptor(MessagesHandlers.prototype, propName)?.get;
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
                }
            });

            try {
                const allModules = window.vendetta?.metro?.cache || new Map();
                for (const [key, module] of allModules) {
                    try {
                        if (module?.exports && typeof module.exports === 'object') {
                            for (const exportKey in module.exports) {
                                const exported = module.exports[exportKey];
                                if (exported?.prototype === MessagesHandlers.prototype || exported instanceof MessagesHandlers) {
                                    const handlers = exported[usedPropertyName];
                                    if (handlers) {
                                        self.patchHandlers.call(self, handlers);
                                        logger.log("BetterChatGestures: Found and patched existing instance during load!");
                                        break;
                                    }
                                }
                            }
                        }
                    } catch {}
                }
            } catch (error) {
                logger.warn("BetterChatGestures: Could not search for existing instance", error);
            }

            this.unpatchGetter = () => {
                try {
                    if (origGetParams && usedPropertyName) {
                        Object.defineProperty(MessagesHandlers.prototype, usedPropertyName, {
                            configurable: true,
                            get: origGetParams
                        });
                    }
                } catch (error) {
                    logger.error("BetterChatGestures: Error in unpatchGetter", error);
                }
            };
        } else {
            logger.error("BetterChatGestures: Could not find params getter!");
        }

        // 🚫 Patch toggleReaction pour bloquer la première réaction
        try {
            const Reactions = findByProps("toggleReaction", "addReaction");
            if (Reactions?.toggleReaction) {
                let firstReactionBlocked = false;
                const unpatchReaction = instead("toggleReaction", Reactions, (args, orig) => {
                    if (!firstReactionBlocked) {
                        firstReactionBlocked = true;
                        logger.log("BetterChatGestures: Première réaction bloquée (double tap)");
                        return;
                    }
                    return orig(...args);
                });
                this.patches.push(unpatchReaction);
                logger.log("BetterChatGestures: Patch toggleReaction appliqué avec succès");
            } else {
                logger.warn("BetterChatGestures: toggleReaction introuvable");
            }
        } catch (e) {
            logger.error("BetterChatGestures: Erreur dans le patch toggleReaction", e);
        }
    },

    onUnload() {
        this.resetTapState();
        if (this.unpatchGetter) this.unpatchGetter();
        if (this.unpatchHandlers) this.unpatchHandlers();
        if (this.timeoutTap) {
            clearTimeout(this.timeoutTap);
            this.timeoutTap = null;
        }
    },

    settings: Settings
};

export default BetterChatGestures;
