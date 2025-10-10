import { findByProps, findByStoreName } from "@vendetta/metro";
import { ReactNative } from "@vendetta/metro/common";
import { after, before, instead } from "@vendetta/patcher";
import { storage, manifest } from "@vendetta/plugin";
import Settings from "./components/Settings";
import { DefaultNativeEvent, DoubleTapStateProps, Plugin, NativeEvent } from "./def";
import { findInReactTree } from "@vendetta/utils";
import { logger } from "@vendetta";

// Try to find modules with fallbacks
const ChatInputRef = findByProps("insertText");
const ChannelStore = findByStoreName("ChannelStore");
const MessageStore = findByStoreName("MessageStore");
const UserStore = findByStoreName("UserStore");
const Messages = findByProps("sendMessage", "startEditMessage");
const ReplyManager = findByProps("createPendingReply");

// Multiple attempts to find MessagesHandlers with different methods
let MessagesHandlersModule;
try {
    MessagesHandlersModule = findByProps("MessagesHandlers");
} catch (e) {
    logger.warn("BetterChatGestures: Could not find MessagesHandlers via findByProps");
}

// Fallback: try to find it via class name
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
            const stateObject = {
                state,
                data: nativeEvent
            };

            if (state === "INCOMPLETE" && nativeEvent) {
                Object.assign(stateObject, {
                    reason: {
                        required: {
                            taps: 2,
                            isAuthor: true
                        },
                        received: {
                            taps: nativeEvent.taps,
                            isAuthor: nativeEvent.isAuthor
                        }
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

    // Improved keyboard opening function with multiple fallbacks
    openKeyboard() {
        if (!storage.keyboardPopup) return;
        
        try {
            // Method 1: Try openSystemKeyboard module
            const keyboardModule = findByProps("openSystemKeyboard");
            
            if (keyboardModule?.openSystemKeyboard) {
                keyboardModule.openSystemKeyboard();
                return;
            }
            
            if (keyboardModule?.openSystemKeyboardForLastCreatedInput) {
                keyboardModule.openSystemKeyboardForLastCreatedInput();
                return;
            }
            
            // Method 2: Try focusing the chat input directly
            const ChatInput = ChatInputRef?.refs?.[0]?.current;
            if (ChatInput?.focus) {
                ChatInput.focus();
                return;
            }
            
            // Method 3: Try React Native Keyboard API
            if (ReactNative.Keyboard?.dismiss) {
                // Dismiss then re-open to force focus
                setTimeout(() => {
                    if (ChatInput?.focus) {
                        ChatInput.focus();
                    }
                }, 50);
            }
        } catch (error) {
            // Silently fail - keyboard opening is a nice-to-have feature
            if (storage.debugMode) {
                logger.error("BetterChatGestures: Error opening keyboard", error);
            }
        }
    },

    patchHandlers(handlers) {
        if (this.handlersInstances.has(handlers)) return;
        this.handlersInstances.add(handlers);

        try {
            // Intercept native double-tap handler - handles FAST double taps
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
                        
                        // Execute custom logic
                        if (isAuthor && storage.userEdit) {
                            Messages?.startEditMessage(
                                ChannelID,
                                MessageID,
                                message.content || ''
                            );
                        } else if (storage.reply && channel) {
                            ReplyManager?.createPendingReply({
                                channel,
                                message,
                                shouldMention: true
                            });
                        }
                        
                        this.openKeyboard();
                        return;
                        
                    } catch (error) {
                        logger.error("BetterChatGestures: Error in handleDoubleTapMessage patch", error);
                    }
                });
                
                this.patches.push(doubleTapPatch);
            }

            // Patch username tapping
            if (handlers.handleTapUsername && storage.tapUsernameMention) {
                const tapUsernamePatch = instead("handleTapUsername", handlers, (args, orig) => {
                    try {
                        if (!storage.tapUsernameMention) return orig.apply(handlers, args);
                        if (!args?.[0]?.nativeEvent) return orig.apply(handlers, args);

                        const ChatInput = ChatInputRef?.refs?.[0]?.current;
                        const { messageId } = args[0].nativeEvent;
                        
                        if (!ChatInput?.props?.channel?.id) return orig.apply(handlers, args);

                        const message = MessageStore.getMessage(
                            ChatInput.props.channel.id,
                            messageId
                        );

                        if (!message?.author) return orig.apply(handlers, args);
                        
                        const discriminatorText = message.author.discriminator !== "0" 
                            ? `#${message.author.discriminator}` 
                            : '';
                        ChatInputRef.insertText(`@${message.author.username}${discriminatorText}`);
                    } catch (error) {
                        logger.error("BetterChatGestures: Error in handleTapUsername patch", error);
                        return orig.apply(handlers, args);
                    }
                });
                this.patches.push(tapUsernamePatch);
            }

            // Patch tap message - handles SLOW double taps
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

                        // Track taps
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
                            this.doubleTapState({
                                state: "INCOMPLETE",
                                nativeEvent: enrichedNativeEvent
                            });
                            return;
                        }

                        // Double tap detected!
                        const currentMessageID = this.currentMessageID;
                        this.resetTapState();

                        if (isAuthor) {
                            if (storage.userEdit) {
                                Messages?.startEditMessage(
                                    ChannelID,
                                    currentMessageID,
                                    enrichedNativeEvent.content
                                );
                            } else if (storage.reply && channel) {
                                ReplyManager?.createPendingReply({
                                    channel,
                                    message,
                                    shouldMention: true
                                });
                            }
                        } else if (storage.reply && channel) {
                            ReplyManager?.createPendingReply({
                                channel,
                                message,
                                shouldMention: true
                            });
                        }

                        this.openKeyboard();

                        this.doubleTapState({
                            state: "COMPLETE",
                            nativeEvent: enrichedNativeEvent
                        });
                    } catch (error) {
                        logger.error("BetterChatGestures: Error in handleTapMessage patch", error);
                        this.resetTapState();
                    }
                });
                this.patches.push(tapMessagePatch);
            }

            this.unpatchHandlers = () => {
                try {
                    this.patches.forEach(unpatch => {
                        if (typeof unpatch === 'function') {
                            unpatch();
                        }
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
                logger.error("BetterChatGestures: MessagesHandlers module not found! Plugin will not work.");
                return;
            }

            storage.tapUsernameMention ??= ReactNative.Platform.select({
                android: false,
                ios: true,
                default: true
            });
            
            if (ReactNative.Platform.OS === 'android') {
                storage.tapUsernameMention = false;
            }
            
            storage.reply ??= true;
            storage.userEdit ??= true;
            storage.keyboardPopup ??= true;
            storage.delay ??= "1000";
            storage.debugMode ??= false;
            
            // Validate delay with minimum of 200ms
            if (!storage.delay || storage.delay === "" || isNaN(parseInt(storage.delay, 10)) || parseInt(storage.delay, 10) < 200) {
                storage.delay = "1000";
            }
            
            logger.log("BetterChatGestures: initialized with delay =", storage.delay);
            
            const self = this;
            
            // Try multiple property names
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
                // ÉTAPE 1 : Patcher proactivement en créant une instance et en forçant l'accès au getter
                try {
                    // Créer une instance factice pour forcer l'accès aux handlers
                    const tempInstance = Object.create(MessagesHandlers.prototype);
                    
                    // Appeler le getter original pour obtenir les handlers
                    const initialHandlers = origGetParams.call(tempInstance);
                    
                    // Patcher immédiatement ces handlers
                    if (initialHandlers) {
                        self.patchHandlers.call(self, initialHandlers);
                        logger.log("BetterChatGestures: Proactively patched handlers on load");
                    }
                } catch (error) {
                    logger.warn("BetterChatGestures: Could not proactively patch, will patch on first access", error);
                }
                
                // ÉTAPE 2 : Aussi intercepter le getter pour patcher les futures instances
                Object.defineProperty(MessagesHandlers.prototype, usedPropertyName, {
                    configurable: true,
                    get() {
                        if (this) self.patchHandlers.call(self, this);
                        return origGetParams.call(this);
                    }
                });
                
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

    settings: Settings
};

export default BetterChatGestures;
