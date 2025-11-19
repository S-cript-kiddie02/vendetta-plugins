import { findByProps, findByStoreName } from "@vendetta/metro";
import { ReactNative } from "@vendetta/metro/common";
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

// Module principal (comme dans le code original)
let MessagesHandlersModule = findByProps("MessagesHandlers");

// Fallback cache (au cas où)
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
// C'est ce verrou qui va empêcher la réaction d'apparaître
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

    // Cette fonction patche l'objet handlers récupéré via le getter
    patchHandlers(handlers) {
        if (this.handlersInstances.has(handlers)) return;
        this.handlersInstances.add(handlers);

        // On reprend exactement le handler mentionné par Claude
        if (handlers.handleDoubleTapMessage) {
            const patch = instead("handleDoubleTapMessage", handlers, (args, orig) => {
                try {
                    const event = args[0];
                    if (!event || !event.nativeEvent) return orig.apply(handlers, args);

                    const { channelId, messageId } = event.nativeEvent;
                    
                    // 1. ON LÈVE LE BOUCLIER IMMÉDIATEMENT
                    isHandlingGesture = true;
                    
                    // On le baisse après 500ms (le temps que le moteur natif se calme)
                    setTimeout(() => { isHandlingGesture = false; }, 500);

                    const message = MessageStore.getMessage(channelId, messageId);
                    const channel = ChannelStore.getChannel(channelId);
                    const currentUser = UserStore.getCurrentUser();

                    if (!message || !currentUser) return;

                    const isAuthor = message.author.id === currentUser.id;

                    // Action du plugin
                    if (isAuthor && storage.userEdit) {
                        Messages.startEditMessage(channelId, messageId, message.content || "");
                    } else if (storage.reply) {
                        ReplyManager.createPendingReply({ channel, message, shouldMention: true });
                    }

                    openKeyboard();

                    // On retourne true pour dire "J'ai géré l'event"
                    return true;

                } catch (e) {
                    logger.error("BetterChatGestures: Error in handleDoubleTapMessage", e);
                    // En cas d'erreur, on laisse faire l'original pour pas casser l'app
                    return orig.apply(handlers, args);
                }
            });
            this.patches.push(patch);
            logger.log("BetterChatGestures: handleDoubleTapMessage patché avec succès.");
        }
    },

    onLoad() {
        if (!MessagesHandlers) {
            logger.error("BetterChatGestures: MessagesHandlers introuvable !");
            return;
        }

        storage.reply ??= true;
        storage.userEdit ??= true;

        const self = this;

        // 1. PATCH DU GETTER 'params' (Méthode Claude)
        // C'est ça qui permet de choper les handlers au bon moment
        const proto = MessagesHandlers.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(proto, "params");

        if (descriptor && descriptor.get) {
            const origGet = descriptor.get;
            Object.defineProperty(proto, "params", {
                configurable: true,
                get() {
                    // On récupère l'objet handlers
                    const handlers = origGet.call(this);
                    if (handlers) {
                        // On applique notre patch dessus
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
            logger.error("BetterChatGestures: Getter 'params' introuvable sur MessagesHandlers.");
        }

        // 2. PATCH BLOQUEUR DE RÉACTION
        // C'est la correction spécifique pour ton bug
        if (ReactionModule && ReactionModule.addReaction) {
            const reactionPatch = instead("addReaction", ReactionModule, (args, orig) => {
                if (isHandlingGesture) {
                    logger.log("BetterChatGestures: Réaction native bloquée par le plugin !");
                    return; // On ne fait RIEN, ce qui annule la réaction
                }
                return orig.apply(ReactionModule, args);
            });
            this.patches.push(reactionPatch);
        } else {
            logger.warn("BetterChatGestures: Module addReaction introuvable, le fix de réaction ne marchera pas.");
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
