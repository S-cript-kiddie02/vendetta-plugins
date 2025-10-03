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
        console.log("BetterChatGestures: patchHandlers called");

        // NEW: Use WeakSet to track instances
        if (this.handlersInstances.has(handlers)) {
            console.log("BetterChatGestures: Handlers already patched, skipping");
            return;
        }
        this.handlersInstances.add(handlers);

        try {
            // CRITICAL: Intercept native double-tap handler with our custom logic
            // This handles FAST double taps (boom-boom)
            if (handlers.handleDoubleTapMessage) {
                console.log("BetterChatGestures: Patching handleDoubleTapMessage with custom logic");
                
                const doubleTapPatch = instead("handleDoubleTapMessage", handlers, (args, orig) => {
                    console.log("BetterChatGestures: Native double-tap intercepted (FAST tap)!");
                    
                    try {
                        if (!args?.[0]?.nativeEvent) {
                            console.log("BetterChatGestures: No nativeEvent in fast tap");
                            return;
                        }
                        
                        const { nativeEvent } = args[0];
                        const ChannelID = nativeEvent.channelId;
                        const MessageID = nativeEvent.messageId;
                        
                        if (!ChannelID || !MessageID) {
                            console.log("BetterChatGestures: No channel/message ID in fast tap");
                            return;
                        }
                        
                        const channel = ChannelStore?.getChannel(ChannelID);
                        const message = MessageStore?.getMessage(ChannelID, MessageID);
                        
                        if (!message) {
                            console.log("BetterChatGestures: Message not found in fast tap");
                            return;
                        }
                        
                        const currentUser = UserStore?.getCurrentUser();
                        const isAuthor = currentUser && message.author ? message.author.id === currentUser.id : false;
                        
                        console.log("BetterChatGestures: Fast double-tap detected!");
                        console.log("BetterChatGestures: isAuthor:", isAuthor, "userEdit:", storage.userEdit, "reply:", storage.reply);
                        
                        // Execute our custom logic
                        if (isAuthor && storage.userEdit) {
                            console.log("BetterChatGestures: Fast tap - Starting edit on own message");
                            Messages?.startEditMessage(
                                ChannelID,
                                MessageID,
                                message.content || ''
                            );
                        } else if (storage.reply && channel) {
                            console.log("BetterChatGestures: Fast tap - Creating reply");
                            ReplyManager?.createPendingReply({
                                channel,
                                message,
                                shouldMention: true
                            });
                        }
                        
                        if ((isAuthor && (storage.userEdit || storage.reply)) || (!isAuthor && storage.reply)) {
                            if (storage.keyboardPopup) {
                                try {
                                    const keyboardModule = findByProps("openSystemKeyboard");
                                    if (keyboardModule) {
                                        console.log("BetterChatGestures: Opening keyboard (fast tap)");
                                        keyboardModule.openSystemKeyboardForLastCreatedInput();
                                    }
                                } catch (error) {
                                    logger.error("BetterChatGestures: Error opening keyboard", error);
                                }
                            }
                        }
                        
                        // Don't call original - we handled it
                        return;
                        
                    } catch (error) {
                        logger.error("BetterChatGestures: Error in handleDoubleTapMessage patch", error);
                    }
                });
                
                this.patches.push(doubleTapPatch);
            }

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

            // patch tapping a message - this handles SLOW double taps (boom... boom)
            if (handlers.handleTapMessage) {
                console.log("BetterChatGestures: Patching handleTapMessage");
                
                const tapMessagePatch = after("handleTapMessage", handlers, (args) => {
                    console.log("BetterChatGestures: handleTapMessage triggered");

                    try {
                        if (!args?.[0]) {
                            console.log("BetterChatGestures: No args, returning");
                            return;
                        }
                        
                        const { nativeEvent }: { nativeEvent: DefaultNativeEvent } = args[0];
                        if (!nativeEvent) {
                            console.log("BetterChatGestures: No nativeEvent, returning");
                            return;
                        }
                        
                        const ChannelID = nativeEvent.channelId;
                        const MessageID = nativeEvent.messageId;
                        if (!ChannelID || !MessageID) {
                            console.log("BetterChatGestures: No channel or message ID, returning");
                            return;
                        }

                        const channel = ChannelStore?.getChannel(ChannelID);
                        const message = MessageStore?.getMessage(ChannelID, MessageID);

                        if (!message) {
                            console.log("BetterChatGestures: Message not found, returning");
                            return;
                        }

                        // Track taps for the same message
                        if (this.currentMessageID === MessageID) {
                            this.currentTapIndex++;
                            console.log(`BetterChatGestures: Tap #${this.currentTapIndex} on same message`);
                        } else {
                            this.resetTapState();
                            this.currentTapIndex = 1;
                            this.currentMessageID = MessageID;
                            console.log("BetterChatGestures: First tap on new message");
                        }

                        let delayMs = 1000; // Default to 1 second for better UX
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
                            console.log("BetterChatGestures: Tap timeout, resetting");
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

                        // SLOW DOUBLE TAP DETECTED!
                        console.log("BetterChatGestures: Slow double-tap detected!");
                        console.log("BetterChatGestures: isAuthor:", isAuthor, "userEdit:", storage.userEdit, "reply:", storage.reply);

                        const currentMessageID = this.currentMessageID;
                        this.resetTapState();

                        if (isAuthor) {
                            if (storage.userEdit) {
                                console.log("BetterChatGestures: Slow tap - Starting edit on own message");
                                Messages?.startEditMessage(
                                    ChannelID,
                                    currentMessageID,
                                    enrichedNativeEvent.content
                                );
                            } else if (storage.reply && channel) {
                                console.log("BetterChatGestures: Slow tap - Creating reply to own message");
                                ReplyManager?.createPendingReply({
                                    channel,
                                    message,
                                    shouldMention: true
                                });
                            }
                        } else if (storage.reply && channel) {
                            console.log("BetterChatGestures: Slow tap - Creating reply to other's message");
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
                                    if (keyboardModule) {
                                        console.log("BetterChatGestures: Opening keyboard (slow tap)");
                                        keyboardModule.openSystemKeyboardForLastCreatedInput();
                                    }
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
                    console.log("BetterChatGestures: Unpatching", this.patches.length, "patches");
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
            storage.delay ??= "1000"; // 1 second default for better UX
            
            if (!storage.delay || storage.delay === "" || isNaN(parseInt(storage.delay, 10)) || parseInt(storage.delay, 10) <= 0) {
                storage.delay = "1000";
            }
            
            logger.log("BetterChatGestures: initialized with delay =", storage.delay);
            logger.log("BetterChatGestures: userEdit =", storage.userEdit);
            logger.log("BetterChatGestures: reply =", storage.reply);
            
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
                logger.error("BetterChatGestures: Could not find params getter!");
            }
        } catch (error) {
            logger.error("BetterChatGestures: Error in onLoad", error);
        }
    },

    onUnload() {
        try {
            console.log("BetterChatGestures: Unloading plugin");
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
