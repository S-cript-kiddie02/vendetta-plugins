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

// Le Cerveau de Discord (Dispatcher)
const FluxDispatcher = findByProps("dispatch", "subscribe");

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
// Ce verrou indique si on doit bloquer les événements de réaction entrants
let isBlockingReactions = false;
let blockingTimeout = null;

function openKeyboard() {
    try {
        const ChatInput = ChatInputRef?.refs?.[0]?.current;
        if (ChatInput?.focus) ChatInput.focus();
    } catch (e) {}
}

const BetterChatGestures = {
    patches: [],
    handlersInstances: new WeakSet(),

    // Fonction pour activer le bouclier pendant 500ms
    activateReactionBlocker() {
        isBlockingReactions = true;
        if (blockingTimeout) clearTimeout(blockingTimeout);
        blockingTimeout = setTimeout(() => {
            isBlockingReactions = false;
        }, 500); // 500ms suffit largement pour bloquer l'event natif
    },

    patchHandlers(handlers) {
        // SÉCURITÉ ANTI-CRASH (WeakSet TypeError)
        if (!handlers || typeof handlers !== 'object') return;
        
        if (this.handlersInstances.has(handlers)) return;
        this.handlersInstances.add(handlers);

        // On patche le handler déclenché par l'option Dev
        if (handlers.handleDoubleTapMessage) {
            const patch = instead("handleDoubleTapMessage", handlers, (args, orig) => {
                try {
                    const event = args[0];
                    if (!event || !event.nativeEvent) return orig.apply(handlers, args);

                    const { channelId, messageId } = event.nativeEvent;

                    // 1. On active le pare-feu FLUX
                    this.activateReactionBlocker();

                    const message = MessageStore.getMessage(channelId, messageId);
                    const channel = ChannelStore.getChannel(channelId);
                    const currentUser = UserStore.getCurrentUser();

                    if (!message || !currentUser) {
                         // Si on ne peut rien faire, on laisse tomber le blocage
                         isBlockingReactions = false;
                         return orig.apply(handlers, args);
                    }

                    const isAuthor = message.author.id === currentUser.id;

                    // 2. Action Custom (Edit ou Reply)
                    if (isAuthor && storage.userEdit) {
                        Messages.startEditMessage(channelId, messageId, message.content || "");
                    } else if (storage.reply) {
                        ReplyManager.createPendingReply({ channel, message, shouldMention: true });
                    }

                    openKeyboard();

                    // 3. On retourne true pour signaler que c'est géré
                    return true;

                } catch (e) {
                    logger.error("BetterChatGestures: Erreur handler", e);
                    isBlockingReactions = false;
                    return orig.apply(handlers, args);
                }
            });
            this.patches.push(patch);
        }
    },

    onLoad() {
        if (!MessagesHandlers || !FluxDispatcher) {
            logger.error("BetterChatGestures: Modules critiques introuvables.");
            return;
        }

        storage.reply ??= true;
        storage.userEdit ??= true;

        const self = this;

        // --- PATCH 1 : INTERCEPTION DU GESTE (Source) ---
        const proto = MessagesHandlers.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(proto, "params");

        if (descriptor && descriptor.get) {
            const origGet = descriptor.get;
            Object.defineProperty(proto, "params", {
                configurable: true,
                get() {
                    const handlers = origGet.call(this);
                    if (handlers) self.patchHandlers(handlers);
                    return handlers;
                }
            });
            this.patches.push(() => {
                Object.defineProperty(proto, "params", { configurable: true, get: origGet });
            });
        }

        // --- PATCH 2 : LE PARE-FEU (Dispatcher) ---
        // C'est ici qu'on tue la réaction
        const dispatchPatch = instead("dispatch", FluxDispatcher, (args, orig) => {
            const event = args[0];
            
            // Si le bouclier est levé ET que c'est un événement d'ajout de réaction
            if (isBlockingReactions && event && event.type === "MESSAGE_REACTION_ADD") {
                logger.log("🛡️ BetterChatGestures: Réaction native bloquée avec succès !");
                return; // ON TUE L'ÉVÉNEMENT (il n'arrivera jamais au store)
            }

            return orig.apply(FluxDispatcher, args);
        });
        this.patches.push(dispatchPatch);
    },

    onUnload() {
        this.patches.forEach(p => p());
        this.patches = [];
        this.handlersInstances = new WeakSet();
        isBlockingReactions = false;
        if (blockingTimeout) clearTimeout(blockingTimeout);
    },

    settings: Settings
};

export default BetterChatGestures;
