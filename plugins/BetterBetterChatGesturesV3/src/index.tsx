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
    isFirstDoubleTapHandled: false,

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

    // Improved keyboard opening function with multiple fallbacks and better timing
    openKeyboard() {
        if (!storage.keyboardPopup) return;
        
        // Use multiple attempts with different delays to ensure keyboard opens
        const attemptOpenKeyboard = (attempt = 0) => {
            if (attempt > 3) return; // Max 3 attempts
            
            setTimeout(() => {
                try {
                    // Method 1: Try openSystemKeyboard module (most reliable)
                    const keyboardModule = findByProps("openSystemKeyboard");
                    
                    if (keyboardModule?.openSystemKeyboard) {
                        if (storage.debugMode) {
                            logger.log("BetterChatGestures: Opening keyboard via openSystemKeyboard");
                        }
                        keyboardModule.openSystemKeyboard();
                        return;
                    }
                    
                    if (keyboardModule?.openSystemKeyboardForLastCreatedInput) {
                        if (storage.debugMode) {
                            logger.log("BetterChatGestures: Opening keyboard via openSystemKeyboardForLastCreatedInput");
                        }
                        keyboardModule.openSystemKeyboardForLastCreatedInput();
                        return;
                    }
                    
                    // Method 2: Try to find and focus the chat input through various methods
                    let chatInput = null;
                    
                    // Try multiple ways to find the chat input
                    if (ChatInputRef?.refs?.[0]?.current) {
                        chatInput = ChatInputRef.refs[0].current;
                    }
                    
                    // Alternative: try to find via React tree if direct ref fails
                    if (!chatInput && window.vendetta?.metro?.cache) {
                        const allModules = window.vendetta.metro.cache;
                        for (const [key, module] of allModules) {
                            try {
                                if (module?.exports?.focus && module.exports?.props?.channel) {
                                    chatInput = module.exports;
                                    break;
                                }
                            } catch (e) {
                                // Continue searching
                            }
                        }
                    }
                    
                    if (chatInput?.focus) {
                        if (storage.debugMode) {
                            logger.log("BetterChatGestures: Opening keyboard via chatInput.focus");
                        }
                        chatInput.focus();
                        return;
                    }
                    
                    // Method 3: Try React Native Keyboard API with forced focus
                    if (ReactNative.TextInput?.State) {
                        try {
                            // Get all text inputs and try to focus the first one
                            const TextInputState = ReactNative.TextInput.State;
                            if (TextInputState.focusTextInput) {
                                // This is a more aggressive approach to focus any text input
                                const textInputs = document.querySelectorAll('input, textarea');
                                if (textInputs.length > 0) {
                                    if (storage.debugMode) {
                                        logger.log("BetterChatGestures: Found text inputs, attempting to focus");
                                    }
                                    // Focus the first text input found
                                    setTimeout(() => {
                                        textInputs[0].focus();
                                    }, 50);
                                    return;
                                }
                            }
                        } catch (error) {
                            // Fall through to next method
                        }
                    }
                    
                    // Method 4: Try using the insertText function which might trigger keyboard
                    if (ChatInputRef?.insertText) {
                        if (storage.debugMode) {
                            logger.log("BetterChatGestures: Attempting to trigger keyboard via insertText");
                        }
                        // Insert empty string to potentially trigger keyboard
                        ChatInputRef.insertText("");
                        
                        // Try again on next attempt
                        if (attempt < 2) {
                            attemptOpenKeyboard(attempt + 1);
                        }
                        return;
                    }
                    
                    // If nothing worked, try again on next attempt
                    if (attempt < 3) {
                        attemptOpenKeyboard(attempt + 1);
                    } else if (storage.debugMode) {
                        logger.log("BetterChatGestures: All keyboard opening methods failed");
                    }
                    
                } catch (error) {
                    if (storage.debugMode) {
                        logger.error("BetterChatGestures: Error opening keyboard attempt " + attempt, error);
                    }
                    // Try again on next attempt if not the last one
                    if (attempt < 3) {
                        attemptOpenKeyboard(attempt + 1);
                    }
                }
            }, attempt * 100 + 50); // Stagger attempts: 50ms, 150ms, 250ms
        };
        
        // Start the keyboard opening process
        attemptOpenKeyboard(0);
    },

    patchHandlers(handlers) {
        if (this.handlersInstances.has(handlers)) return;
        this.handlersInstances.add(handlers);

        try {
            // Intercept native double-tap handler - handles FAST double taps
            if (handlers.handleDoubleTapMessage) {
                const doubleTapPatch = instead("handleDoubleTapMessage", handlers, (args, orig) => {
                    try {
                        // Mark that our patch is active and handling the event
                        this.isFirstDoubleTapHandled = true;
                        
                        if (!args?.[0]?.nativeEvent) return orig?.apply(handlers, args);
                        
                        const { nativeEvent } = args[0];
                        const ChannelID = nativeEvent.channelId;
                        const MessageID = nativeEvent.messageId;
                        
                        if (!ChannelID || !MessageID) return orig?.apply(handlers, args);
                        
                        const channel = ChannelStore?.getChannel(ChannelID);
                        const message = MessageStore?.getMessage(ChannelID, MessageID);
                        
                        if (!message) return orig?.apply(handlers, args);
                        
                        const currentUser = UserStore?.getCurrentUser();
                        const isAuthor = currentUser && message.author ? message.author.id === currentUser.id : false;
                        
                        // Execute custom logic - BLOCK the original function when we handle the action
                        if (isAuthor && storage.userEdit) {
                            Messages?.startEditMessage(
                                ChannelID,
                                MessageID,
                                message.content || ''
                            );
                            this.openKeyboard();
                            return; // Block original function
                        } else if (storage.reply && channel) {
                            ReplyManager?.createPendingReply({
                                channel,
                                message,
                                shouldMention: true
                            });
                            this.openKeyboard();
                            return; // Block original function
                        }
                        
                        // If no custom action was taken, allow the original function
                        return orig?.apply(handlers, args);
                        
                    } catch (error) {
                        logger.error("BetterChatGestures: Error in handleDoubleTapMessage patch", error);
                        // In case of error, run the original function
                        return orig?.apply(handlers, args);
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
                        
                        // Open keyboard after mentioning
                        this.openKeyboard();
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
                                this.openKeyboard();
                            } else if (storage.reply && channel) {
                                ReplyManager?.createPendingReply({
                                    channel,
                                    message,
                                    shouldMention: true
                                });
                                this.openKeyboard();
                            }
                        } else if (storage.reply && channel) {
                            ReplyManager?.createPendingReply({
                                channel,
                                message,
                                shouldMention: true
                            });
                            this.openKeyboard();
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
            storage.debugMode ??= true;
            
            // Initialize the first tap handling flag
            this.isFirstDoubleTapHandled = false;
            
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
                // Intercept the getter
                Object.defineProperty(MessagesHandlers.prototype, usedPropertyName, {
                    configurable: true,
                    get() {
                        if (this) self.patchHandlers.call(self, this);
                        return origGetParams.call(this);
                    }
                });
                
                // NEW: Force immediate instance patching with multiple attempts
                const forcePatchInstance = () => {
                    try {
                        // Method 1: Search for existing instances in React fiber cache
                        const allModules = window.vendetta?.metro?.cache || new Map();
                        let foundInstance = false;
                        
                        for (const [key, module] of allModules) {
                            try {
                                if (module?.exports && typeof module.exports === 'object') {
                                    for (const exportKey in module.exports) {
                                        const exported = module.exports[exportKey];
                                        if (exported && 
                                            (exported.prototype === MessagesHandlers.prototype ||
                                             exported instanceof MessagesHandlers)) {
                                            // Try to access the getter via this instance
                                            const handlers = exported[usedPropertyName];
                                            if (handlers) {
                                                self.patchHandlers.call(self, handlers);
                                                logger.log("BetterChatGestures: Found and patched existing instance during load!");
                                                foundInstance = true;
                                                return true;
                                            }
                                        }
                                    }
                                }
                            } catch (e) {
                                // Ignore search errors
                            }
                        }
                        
                        // Method 2: Try to create a new instance if no existing one found
                        if (!foundInstance) {
                            try {
                                const newInstance = new MessagesHandlers();
                                const handlers = newInstance[usedPropertyName];
                                if (handlers) {
                                    self.patchHandlers.call(self, handlers);
                                    logger.log("BetterChatGestures: Created and patched new instance!");
                                    foundInstance = true;
                                    return true;
                                }
                            } catch (createError) {
                                logger.warn("BetterChatGestures: Could not create new instance", createError);
                            }
                        }
                        
                        if (!foundInstance) {
                            logger.log("BetterChatGestures: No instance found, will patch on first access");
                        }
                        return foundInstance;
                    } catch (error) {
                        logger.warn("BetterChatGestures: Could not force patch instance", error);
                        return false;
                    }
                };

                // Try to patch immediately, then retry after a short delay
                let patched = forcePatchInstance();
                if (!patched) {
                    setTimeout(() => {
                        logger.log("BetterChatGestures: Retrying instance patching after delay");
                        forcePatchInstance();
                    }, 500);
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
