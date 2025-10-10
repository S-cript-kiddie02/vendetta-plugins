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

logger.log("BetterChatGestures: Modules found:", {
    ChatInputRef: !!ChatInputRef,
    ChannelStore: !!ChannelStore,
    MessageStore: !!MessageStore,
    UserStore: !!UserStore,
    Messages: !!Messages,
    ReplyManager: !!ReplyManager
});

// Multiple attempts to find MessagesHandlers with different methods
let MessagesHandlersModule;
try {
    MessagesHandlersModule = findByProps("MessagesHandlers");
    logger.log("BetterChatGestures: Found MessagesHandlers via findByProps");
} catch (e) {
    logger.warn("BetterChatGestures: Could not find MessagesHandlers via findByProps", e);
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
logger.log("BetterChatGestures: MessagesHandlers exists:", !!MessagesHandlers);

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
        logger.log("BetterChatGestures: patchHandlers called");
        
        if (this.handlersInstances.has(handlers)) {
            logger.log("BetterChatGestures: Handlers already patched, skipping");
            return;
        }
        this.handlersInstances.add(handlers);

        try {
            // Log ALL properties and methods to understand the new structure
            logger.log("BetterChatGestures: ===== FULL HANDLERS ANALYSIS =====");
            logger.log("BetterChatGestures: Type of handlers:", typeof handlers);
            logger.log("BetterChatGestures: Is array?", Array.isArray(handlers));
            
            const allKeys = Object.keys(handlers);
            logger.log("BetterChatGestures: All keys:", allKeys);
            
            allKeys.forEach(key => {
                const value = handlers[key];
                const type = typeof value;
                logger.log(`BetterChatGestures: - ${key}: ${type}`, value);
                
                // If it's an object, explore it further
                if (type === 'object' && value !== null && !Array.isArray(value)) {
                    const subKeys = Object.keys(value);
                    logger.log(`BetterChatGestures:   → Sub-keys of ${key}:`, subKeys);
                    subKeys.forEach(subKey => {
                        logger.log(`BetterChatGestures:     - ${subKey}: ${typeof value[subKey]}`);
                    });
                }
            });
            
            logger.log("BetterChatGestures: ===== END ANALYSIS =====");
            
            // Try to find ANY method that might be related to message tapping
            const potentialTapMethods = allKeys.filter(key => 
                typeof handlers[key] === 'function' && 
                (key.toLowerCase().includes('tap') || 
                 key.toLowerCase().includes('press') || 
                 key.toLowerCase().includes('click') ||
                 key.toLowerCase().includes('message'))
            );
            
            logger.log("BetterChatGestures: Potential tap-related methods:", potentialTapMethods);
            
            // Patch getMessage as a test
            if (handlers.getMessage) {
                logger.log("BetterChatGestures: Patching getMessage for exploration");
                const getMessagePatch = after("getMessage", handlers, (args, result) => {
                    logger.log("BetterChatGestures: getMessage called with args:", args);
                    logger.log("BetterChatGestures: getMessage result:", result);
                });
                this.patches.push(getMessagePatch);
            }

            this.unpatchHandlers = () => {
                try {
                    logger.log("BetterChatGestures: Unpatching handlers");
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
            logger.log("BetterChatGestures: onLoad called");
            
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
            
            if (!storage.delay || storage.delay === "" || isNaN(parseInt(storage.delay, 10)) || parseInt(storage.delay, 10) < 200) {
                storage.delay = "1000";
            }
            
            logger.log("BetterChatGestures: Configuration:", {
                reply: storage.reply,
                userEdit: storage.userEdit,
                keyboardPopup: storage.keyboardPopup,
                delay: storage.delay,
                tapUsernameMention: storage.tapUsernameMention,
                debugMode: storage.debugMode
            });
            
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
            
            if (!origGetParams || !usedPropertyName) {
                logger.error("BetterChatGestures: Could not find params getter!");
                return;
            }
            
            Object.defineProperty(MessagesHandlers.prototype, usedPropertyName, {
                configurable: true,
                get() {
                    const handlers = origGetParams.call(this);
                    
                    if (this && handlers) {
                        self.patchHandlers.call(self, handlers);
                    }
                    
                    return handlers;
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
            
            logger.log("BetterChatGestures: onLoad completed successfully");
        } catch (error) {
            logger.error("BetterChatGestures: Error in onLoad", error);
        }
    },

    onUnload() {
        try {
            logger.log("BetterChatGestures: onUnload called");
            this.resetTapState();
            
            if (this.unpatchGetter) this.unpatchGetter();
            if (this.unpatchHandlers) this.unpatchHandlers();
            
            if (this.timeoutTap) {
                clearTimeout(this.timeoutTap);
                this.timeoutTap = null;
            }
            
            logger.log("BetterChatGestures: onUnload completed");
        } catch (error) {
            logger.error("BetterChatGestures: Error in onUnload", error);
        }
    },

    settings: Settings
};

export default BetterChatGestures;
