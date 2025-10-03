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

// NEW: Multiple attempts to find MessagesHandlers with different methods
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
    handlersInstances: new WeakSet(), // Track patched instances

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

    patchHandlers(handlers) {
        console.log("BetterChatGestures: patchHandlers called with:", handlers);

        // NEW: Use WeakSet to track instances
        if (this.handlersInstances.has(handlers)) return;
        this.handlersInstances.add(handlers);

        try {
            // patch username tapping to mention user instead
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

            // NEW: Patch handleDoubleTapMessage (Discord 294.18+)
            if (handlers.handleDoubleTapMessage) {
                console.log("BetterChatGestures: Patching handleDoubleTapMessage");
                
                const doubleTapPatch = instead("handleDoubleTapMessage", handlers, (args, orig) => {
                    console.log("BetterChatGestures: handleDoubleTapMessage intercepted with args:", args);
                    
                    try {
                        if (!args?.[0]?.nativeEvent) return orig.apply(handlers, args);
                        
                        const { nativeEvent } = args[0];
                        const ChannelID = nativeEvent.channelId;
                        const MessageID = nativeEvent.messageId;
                        
                        if (!ChannelID || !MessageID) return orig.apply(handlers, args);
                        
                        const channel = ChannelStore?.getChannel(ChannelID);
                        const message = MessageStore?.getMessage(ChannelID, MessageID);
                        
                        if (!message) return orig.apply(handlers, args);
                        
                        const currentUser = UserStore?.getCurrentUser();
                        const isAuthor = currentUser && message.author ? message.author.id === currentUser.id : false;
                        
                        console.log("BetterChatGestures: Double tap detected - isAuthor:", isAuthor, "userEdit:", storage.userEdit, "reply:", storage.reply);
                        
                        // Execute our custom logic instead of default behavior
                        if (isAuthor && storage.userEdit) {
                            console.log("BetterChatGestures: Starting edit for own message");
                            Messages?.startEditMessage(
                                ChannelID,
                                MessageID,
                                message.content || ''
                            );
                            
                            if (storage.keyboardPopup) {
                                try {
                                    const keyboardModule = findByProps("openSystemKeyboard");
                                    if (keyboardModule) keyboardModule.openSystemKeyboardForLastCreatedInput();
                                } catch (error) {
                                    logger.error("BetterChatGestures: Error opening keyboard", error);
                                }
                            }
                            
                            // Don't call original - we handled it
                            return;
                            
                        } else if (storage.reply && channel) {
                            console.log("BetterChatGestures: Creating reply");
                            ReplyManager?.createPendingReply({
                                channel,
                                message,
                                shouldMention: true
                            });
                            
                            if (storage.keyboardPopup) {
                                try {
                                    const keyboardModule = findByProps("openSystemKeyboard");
                                    if (keyboardModule) keyboardModule.openSystemKeyboardForLastCreatedInput();
                                } catch (error) {
                                    logger.error("BetterChatGestures: Error opening keyboard", error);
                                }
                            }
                            
                            // Don't call original - we handled it
                            return;
                        }
                        
                        // If none of our conditions matched, use default behavior
                        console.log("BetterChatGestures: No custom action, using default behavior");
                        return orig.apply(handlers, args);
                        
                    } catch (error) {
                        logger.error("BetterChatGestures: Error in handleDoubleTapMessage patch", error);
                        return orig.apply(handlers, args);
                    }
                });
                
                this.patches.push(doubleTapPatch);
            }

            // patch tapping a message (fallback for older Discord versions)
            if (handlers.handleTapMessage) {
                const tapMessagePatch = after("handleTapMessage", handlers, (args) => {
                    console.log("BetterChatGestures: handleTapMessage called with args:", args);

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

                        let delayMs = 300;
                        if (storage.delay) {
                            const parsedDelay = parseInt(storage.delay, 10);
                            if (!isNaN(parsedDelay) && parsedDelay > 0) {
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

                        if ((isAuthor && (storage.userEdit || storage.reply)) || 
                            (!isAuthor && storage.reply)) {
                            if (storage.keyboardPopup) {
                                try {
                                    const keyboardModule = findByProps("openSystemKeyboard");
                                    if (keyboardModule) keyboardModule.openSystemKeyboardForLastCreatedInput();
                                } catch (error) {
                                    logger.error("BetterChatGestures: Error opening keyboard", error);
                                }
                            }
                        }

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
            // Check if required modules are available
            if (!MessagesHandlers) {
                logger.error("BetterChatGestures: MessagesHandlers module not found! Plugin will not work.");
                // Try alternative patching method
                this.tryAlternativePatching();
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
            storage.keyboardPopup ??= false;
            storage.delay ??= "300";
            
            if (!storage.delay || storage.delay === "" || isNaN(parseInt(storage.delay, 10)) || parseInt(storage.delay, 10) <= 0) {
                storage.delay = "300";
            }
            
            logger.log("BetterChatGestures: initialized with delay =", storage.delay);
            
            const self = this;
            
            // NEW: Try multiple property names that might exist
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
                logger.error("BetterChatGestures: Could not find params getter! Trying alternative method...");
                this.tryAlternativePatching();
            }
        } catch (error) {
            logger.error("BetterChatGestures: Error in onLoad", error);
        }
    },

    // NEW: Alternative patching method if the primary method fails
    tryAlternativePatching() {
        try {
            logger.log("BetterChatGestures: Attempting alternative patching method...");
            
            // Try to find and patch the message component directly
            const MessageComponent = findByProps("default")?.default;
            if (MessageComponent) {
                const patchComponent = before("type", MessageComponent, (args) => {
                    // This is a fallback approach - may need adjustment
                    logger.log("BetterChatGestures: Alternative patch triggered");
                });
                this.patches.push(patchComponent);
            }
        } catch (error) {
            logger.error("BetterChatGestures: Alternative patching failed", error);
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
