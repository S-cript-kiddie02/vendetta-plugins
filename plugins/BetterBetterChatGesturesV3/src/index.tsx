import { findByProps, findByStoreName } from "@vendetta/metro";
import { ReactNative } from "@vendetta/metro/common";
import { instead } from "@vendetta/patcher";
import { storage, manifest } from "@vendetta/plugin";
import Settings from "./components/Settings";
import { logger } from "@vendetta";

// --- 1. MODULES (Base Claude) ---
const ChannelStore = findByStoreName("ChannelStore");
const MessageStore = findByStoreName("MessageStore");
const UserStore = findByStoreName("UserStore");
const Messages = findByProps("sendMessage", "startEditMessage");
const ReplyManager = findByProps("createPendingReply");
const ChatInputRef = findByProps("insertText");

// Ajout : Le Dispatcher pour bloquer la réaction fantôme
const FluxDispatcher = findByProps("dispatch", "subscribe");

// --- 2. RECHERCHE ROBUSTE DE MESSAGESHANDLERS (Base Claude) ---
let MessagesHandlersModule;
try {
    MessagesHandlersModule = findByProps("MessagesHandlers");
} catch (e) {
    logger.warn("BetterChatGestures: Could not find MessagesHandlers via findByProps");
}

// Fallback (La boucle qui marchait bien chez toi)
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

// --- STATE ---
let isBlockingReactions = false;
let blockingTimeout = null;

const BetterChatGestures = {
    patches: [],
    handlersInstances: new WeakSet(),

    // Helper clavier
    openKeyboard() {
        if (!storage.keyboardPopup) return;
        try {
            const ChatInput = ChatInputRef?.refs?.[0]?.current;
            if (ChatInput?.focus) ChatInput.focus();
        } catch (error) {}
    },

    // --- 3. LE PATCH PRINCIPAL (Base Claude + Fix Crash + Fix Return) ---
    patchHandlers(handlers) {
        // FIX CRASH : Vérification stricte que c'est un objet avant d'utiliser WeakSet
        if (!handlers || typeof handlers !== 'object') return;
        
        if (this.handlersInstances.has(handlers)) return;
        this.handlersInstances.add(handlers);

        if (handlers.handleDoubleTapMessage) {
            const doubleTapPatch = instead("handleDoubleTapMessage", handlers, (args, orig) => {
                try {
                    // 1. On active immédiatement le bouclier anti-réaction
                    isBlockingReactions = true;
                    if (blockingTimeout) clearTimeout(blockingTimeout);
                    blockingTimeout = setTimeout(() => { isBlockingReactions = false; }, 500);

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
                    
                    // Action Custom
                    if (isAuthor && storage.userEdit) {
                        Messages?.startEditMessage(ChannelID, MessageID, message.content || '');
                    } else if (storage.reply && channel) {
                        ReplyManager?.createPendingReply({
                            channel,
                            message,
                            shouldMention: true
                        });
                    }
                    
                    this.openKeyboard();
                    
                    // FIX RETURN : On retourne true pour dire au système "C'est bon, j'ai géré"
                    // C'est souvent ce qui manquait pour empêcher la propagation native
                    return true;
                    
                } catch (error) {
                    logger.error("BetterChatGestures: Error in handleDoubleTapMessage patch", error);
                    isBlockingReactions = false; // On baisse le bouclier en cas d'erreur
                    return orig.apply(handlers, args);
                }
            });
            
            this.patches.push(doubleTapPatch);
        }
    },

    onLoad() {
        if (!MessagesHandlers) {
            logger.error("BetterChatGestures: Plugin will not work (MessagesHandlers missing).");
            return;
        }

        storage.reply ??= true;
        storage.userEdit ??= true;
        storage.keyboardPopup ??= true;
        
        const self = this;

        // --- 4. PATCH DU DISPATCHER (Le "Silencieux") ---
        // C'est ça qui va tuer la réaction de la "première fois"
        if (FluxDispatcher) {
            const dispatchPatch = instead("dispatch", FluxDispatcher, (args, orig) => {
                const event = args[0];
                // Si le bouclier est levé ET que c'est une réaction ajoutée
                if (isBlockingReactions && event && event.type === "MESSAGE_REACTION_ADD") {
                    // On bloque silencieusement
                    return; 
                }
                return orig.apply(FluxDispatcher, args);
            });
            this.patches.push(dispatchPatch);
        }

        // --- 5. INJECTION DANS LE GETTER (Base Claude) ---
        const possiblePropertyNames = ["params", "handlers", "_params", "messageHandlers"];
        let origGetParams = null;
        let usedPropertyName = null;
        
        for (const propName of possiblePropertyNames) {
            origGetParams = Object.getOwnPropertyDescriptor(MessagesHandlers.prototype, propName)?.get;
            if (origGetParams) {
                usedPropertyName = propName;
                break;
            }
        }
        
        if (origGetParams && usedPropertyName) {
            Object.defineProperty(MessagesHandlers.prototype, usedPropertyName, {
                configurable: true,
                get() {
                    // On récupère les handlers originaux
                    const handlers = origGetParams.call(this);
                    // On tente de patcher (avec la sécurité anti-crash ajoutée dans patchHandlers)
                    if (handlers) {
                        self.patchHandlers.call(self, handlers);
                    }
                    return handlers;
                }
            });
            
            this.patches.push(() => {
                try {
                    if (origGetParams && usedPropertyName) {
                        Object.defineProperty(MessagesHandlers.prototype, usedPropertyName, {
                            configurable: true,
                            get: origGetParams
                        });
                    }
                } catch (e) {}
            });
        }
    },

    onUnload() {
        this.patches.forEach(unpatch => unpatch?.());
        this.patches = [];
        this.handlersInstances = new WeakSet();
        isBlockingReactions = false;
        if (blockingTimeout) clearTimeout(blockingTimeout);
    },

    settings: Settings
};

export default BetterChatGestures;
