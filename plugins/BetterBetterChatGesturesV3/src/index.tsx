import { findByProps, findByStoreName } from "@vendetta/metro";
import { instead } from "@vendetta/patcher";
import { storage, manifest } from "@vendetta/plugin";
import Settings from "./components/Settings";
import { logger } from "@vendetta";

// --- MODULES ---
const ChannelStore = findByStoreName("ChannelStore");
const MessageStore = findByStoreName("MessageStore");
const UserStore = findByStoreName("UserStore");
const Messages = findByProps("sendMessage", "startEditMessage");
const ReplyManager = findByProps("createPendingReply");
const ChatInputRef = findByProps("insertText");

// Module pour bloquer la réaction native
const ReactionModule = findByProps("addReaction");

// Recherche sécurisée de MessagesHandlers
let MessagesHandlersModule = findByProps("MessagesHandlers");
if (!MessagesHandlersModule) {
    const allModules = window.vendetta?.metro?.cache || new Map();
    for (const [_, module] of allModules) {
        if (module?.exports?.MessagesHandlers) {
            MessagesHandlersModule = module.exports;
            break;
        }
    }
}
const MessagesHandlers = MessagesHandlersModule?.MessagesHandlers;

// --- STATE ---
let isHandlingGesture = false;

function openKeyboard() {
    try {
        const ChatInput = ChatInputRef?.refs?.[0]?.current;
        if (ChatInput?.focus) ChatInput.focus();
    } catch (e) {}
}

const BetterChatGestures = {
    patches: [],
    handlersInstances: new WeakSet(),

    // --- C'EST ICI QUE ÇA CRASHAIT AVANT ---
    patchHandlers(handlers) {
        // FIX: On vérifie que c'est bien un objet avant de le mettre dans le WeakSet
        if (!handlers || typeof handlers !== 'object') return;
        
        if (this.handlersInstances.has(handlers)) return;
        this.handlersInstances.add(handlers);

        // Si l'objet contient le handler du double tap (option dev activée)
        if (handlers.handleDoubleTapMessage) {
            const patch = instead("handleDoubleTapMessage", handlers, (args, orig) => {
                try {
                    const event = args[0];
                    if (!event || !event.nativeEvent) return orig.apply(handlers, args);

                    const { channelId, messageId } = event.nativeEvent;
                    
                    // 1. ACTION DÉTECTÉE : ON LÈVE LE BOUCLIER ANTI-RÉACTION
                    isHandlingGesture = true;
                    setTimeout(() => { isHandlingGesture = false; }, 500);

                    const message = MessageStore.getMessage(channelId, messageId);
                    const channel = ChannelStore.getChannel(channelId);
                    const currentUser = UserStore.getCurrentUser();

                    if (!message || !currentUser) {
                         // Si on ne peut pas traiter, on laisse Discord faire (réaction)
                         isHandlingGesture = false;
                         return orig.apply(handlers, args);
                    }

                    const isAuthor = message.author.id === currentUser.id;

                    // Action Custom
                    if (isAuthor && storage.userEdit) {
                        Messages.startEditMessage(channelId, messageId, message.content || "");
                    } else if (storage.reply) {
                        ReplyManager.createPendingReply({ channel, message, shouldMention: true });
                    }

                    openKeyboard();

                    // On retourne true pour dire "C'est géré"
                    return true;

                } catch (e) {
                    // En cas d'erreur interne, on désactive le bouclier et on laisse faire
                    isHandlingGesture = false;
                    logger.error("BetterChatGestures: Error", e);
                    return orig.apply(handlers, args);
                }
            });
            this.patches.push(patch);
        }
    },

    onLoad() {
        if (!MessagesHandlers) {
            logger.error("BetterChatGestures: MessagesHandlers introuvable.");
            return;
        }

        storage.reply ??= true;
        storage.userEdit ??= true;
        storage.debugMode ??= false;

        const self = this;

        // 1. PATCH DU GETTER 'params'
        const proto = MessagesHandlers.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(proto, "params");

        if (descriptor && descriptor.get) {
            const origGet = descriptor.get;
            Object.defineProperty(proto, "params", {
                configurable: true,
                get() {
                    const handlers = origGet.call(this);
                    // On envoie à patchHandlers qui fera la vérification de type
                    if (handlers) {
                        self.patchHandlers(handlers);
                    }
                    return handlers;
                }
            });

            this.patches.push(() => {
                Object.defineProperty(proto, "params", {
                    configurable: true,
                    get: origGet
                });
            });
        } else {
            logger.error("BetterChatGestures: Getter 'params' introuvable.");
        }

        // 2. PATCH BLOQUEUR DE RÉACTION (Le correctif du bug initial)
        if (ReactionModule && ReactionModule.addReaction) {
            const reactionPatch = instead("addReaction", ReactionModule, (args, orig) => {
                // Si le bouclier est levé (double tap en cours), on bloque l'appel
                if (isHandlingGesture) {
                    if (storage.debugMode) logger.log("BetterChatGestures: Réaction bloquée !");
                    return; 
                }
                return orig.apply(ReactionModule, args);
            });
            this.patches.push(reactionPatch);
        }
    },

    onUnload() {
        this.patches.forEach(p => p());
        this.patches = [];
        this.handlersInstances = new WeakSet();
        isHandlingGesture = false;
    },

    settings: Settings
};

export default BetterChatGestures;
