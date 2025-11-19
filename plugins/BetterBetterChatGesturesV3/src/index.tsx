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

// --- RECHERCHE DU MODULE ---
let MessagesHandlersModule = findByProps("MessagesHandlers");

// Fallback recherche
if (!MessagesHandlersModule) {
    const allModules = window.vendetta?.metro?.cache || new Map();
    for (const [key, module] of allModules) {
        if (module?.exports?.MessagesHandlers) {
            MessagesHandlersModule = module.exports;
            break;
        }
    }
}

const MessagesHandlers = MessagesHandlersModule?.MessagesHandlers;

// --- STATE LOCAL POUR LE DOUBLE TAP MANUEL ---
let lastTapTime = 0;
let lastTapMessageId = null;
const DOUBLE_TAP_DELAY = 400; // ms

const BetterChatGestures = {
    patches: [],
    handlersPatched: new WeakSet(),

    openKeyboard() {
        try {
            const ChatInput = ChatInputRef?.refs?.[0]?.current;
            if (ChatInput?.focus) ChatInput.focus();
        } catch (e) {}
    },

    // Cette fonction applique le patch sur une instance spécifique de handlers
    applyPatchToInstance(instance) {
        if (this.handlersPatched.has(instance)) return;
        this.handlersPatched.add(instance);
        
        // ON PATCHE UNIQUEMENT handleTapMessage
        // C'est la seule fonction dont on est sûr de l'existence
        if (instance.handleTapMessage) {
            const patch = instead("handleTapMessage", instance, (args, orig) => {
                try {
                    const event = args[0];
                    if (!event || !event.nativeEvent) return orig.apply(instance, args);

                    const { messageId, channelId } = event.nativeEvent;
                    const now = Date.now();

                    // --- LOGIQUE DE DÉTECTION DOUBLE TAP ---
                    const isSameMessage = messageId === lastTapMessageId;
                    const isFastEnough = (now - lastTapTime) < DOUBLE_TAP_DELAY;

                    if (isSameMessage && isFastEnough) {
                        // C'EST UN DOUBLE TAP !
                        logger.log("BetterChatGestures: Double Tap Manous detecté !");
                        
                        // Reset pour éviter un triple tap
                        lastTapTime = 0;
                        lastTapMessageId = null;

                        // Récupération des données
                        const message = MessageStore.getMessage(channelId, messageId);
                        const channel = ChannelStore.getChannel(channelId);
                        const currentUser = UserStore.getCurrentUser();

                        if (!message || !currentUser) return; // Si erreur, on ne fait rien

                        const isAuthor = message.author.id === currentUser.id;

                        // Action
                        if (isAuthor && storage.userEdit) {
                            Messages.startEditMessage(channelId, messageId, message.content || "");
                        } else if (storage.reply) {
                            ReplyManager.createPendingReply({ channel, message, shouldMention: true });
                        }

                        this.openKeyboard();
                        
                        // CRITIQUE : On retourne true (ou rien) sans appeler orig()
                        // Cela empêche Discord de traiter ce 2ème clic
                        // Donc pas de zoom, pas de réaction, rien.
                        return true;
                    }

                    // C'est un premier tap (ou trop lent)
                    lastTapTime = now;
                    lastTapMessageId = messageId;

                    // On laisse le clic normal se faire (pour ouvrir clavier, etc.)
                    return orig.apply(instance, args);

                } catch (e) {
                    logger.error("BetterChatGestures: Error in handleTapMessage", e);
                    return orig.apply(instance, args);
                }
            });
            this.patches.push(patch);
            logger.log("BetterChatGestures: Patch appliqué sur handleTapMessage");
        } else {
            logger.error("BetterChatGestures: handleTapMessage introuvable sur l'instance !");
        }
    },

    onLoad() {
        if (!MessagesHandlers) {
            logger.error("BetterChatGestures: MessagesHandlers class not found.");
            return;
        }

        storage.reply ??= true;
        storage.userEdit ??= true;
        storage.keyboardPopup ??= true;

        const self = this;
        const proto = MessagesHandlers.prototype;
        
        // On cherche le getter 'params' (c'est celui qui renvoie l'objet contenant les fonctions)
        // D'après tes logs, c'est bien 'params'
        const descriptor = Object.getOwnPropertyDescriptor(proto, "params");
        
        if (descriptor && descriptor.get) {
            const originalGetter = descriptor.get;
            Object.defineProperty(proto, "params", {
                configurable: true,
                get() {
                    const result = originalGetter.call(this);
                    if (result) {
                        // Dès qu'on récupère l'objet, on injecte notre logique
                        self.applyPatchToInstance(result);
                    }
                    return result;
                }
            });

            this.patches.push(() => {
                Object.defineProperty(proto, "params", {
                    configurable: true,
                    get: originalGetter
                });
            });
        } else {
            logger.error("BetterChatGestures: Getter 'params' introuvable.");
        }
    },

    onUnload() {
        this.patches.forEach(p => p());
        this.patches = [];
        this.handlersPatched = new WeakSet();
    },

    settings: Settings
};

export default BetterChatGestures;
