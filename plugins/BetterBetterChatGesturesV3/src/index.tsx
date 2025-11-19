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

// On cherche le module qui gère les réactions pour le bloquer
const ReactionModule = findByProps("addReaction");

// --- RECHERCHE DU GESTURE MODULE (SMART SEARCH) ---
// On cherche un module qui possède à la fois handleTap et handleLongPress
// C'est la signature unique du gestionnaire de liste de messages
let GestureModule;

const findGestureModule = () => {
    if (GestureModule) return GestureModule;

    const cache = window.vendetta?.metro?.cache || new Map();
    for (const [_, module] of cache) {
        const exports = module?.exports;
        if (!exports) continue;

        // On vérifie exports, default et prototype
        const candidates = [exports, exports.default, exports.prototype];
        
        for (const obj of candidates) {
            if (obj && typeof obj.handleTap === 'function' && typeof obj.handleLongPress === 'function') {
                logger.log("BetterChatGestures: Module de gestes trouvé via signature (handleTap + handleLongPress) !");
                return obj;
            }
        }
    }
    return null;
};

// --- STATE ---
let isHandlingGesture = false; // Verrou pour bloquer la réaction native

// Helper clavier
function openKeyboard() {
    try {
        const ChatInput = ChatInputRef?.refs?.[0]?.current;
        if (ChatInput?.focus) ChatInput.focus();
    } catch (e) {}
}

const BetterChatGestures = {
    patches: [],
    
    onLoad() {
        // 1. Trouver le module
        GestureModule = findGestureModule();

        if (!GestureModule) {
            logger.error("BetterChatGestures: FATAL - Impossible de trouver le module de gestes, même par signature.");
            return;
        }

        // Paramètres par défaut
        storage.reply ??= true;
        storage.userEdit ??= true;

        // 2. Patcher addReaction pour empêcher le bug de la "première fois"
        // Si on détecte que c'est nous qui gérons le tap, on bloque l'ajout de réaction
        if (ReactionModule && ReactionModule.addReaction) {
            const reactionPatch = instead("addReaction", ReactionModule, (args, orig) => {
                if (isHandlingGesture) {
                    logger.log("BetterChatGestures: Réaction native bloquée avec succès !");
                    return; // On ne fait rien, on annule la réaction
                }
                return orig.apply(ReactionModule, args);
            });
            this.patches.push(reactionPatch);
        }

        // 3. Patcher handleTap (C'est le handler du Double Tap via l'option Dev)
        // Note: Avec l'option dev, "handleTap" est appelé pour le double tap
        const tapPatch = instead("handleTap", GestureModule, (args, orig) => {
            try {
                const event = args[0];
                // Sécurité
                if (!event || !event.nativeEvent) return orig.apply(GestureModule, args);

                const { messageId, channelId } = event.nativeEvent;
                
                // On récupère les infos
                const message = MessageStore.getMessage(channelId, messageId);
                const channel = ChannelStore.getChannel(channelId);
                const currentUser = UserStore.getCurrentUser();

                if (!message || !currentUser) return orig.apply(GestureModule, args);

                // ACTION PLUGIN
                // On active le verrou pour bloquer addReaction
                isHandlingGesture = true;
                
                // On désactive le verrou après 500ms (le temps que le natif se calme)
                setTimeout(() => { isHandlingGesture = false; }, 500);

                const isAuthor = message.author.id === currentUser.id;
                logger.log(`Action déclenchée (Auteur: ${isAuthor})`);

                if (isAuthor && storage.userEdit) {
                    Messages.startEditMessage(channelId, messageId, message.content || "");
                } else if (storage.reply) {
                    ReplyManager.createPendingReply({ channel, message, shouldMention: true });
                }
                
                openKeyboard();

                // On retourne true pour essayer de bloquer la propagation JS (si possible)
                return true; 

            } catch (e) {
                logger.error("Error in handleTap patch", e);
                isHandlingGesture = false; // Sécurité
                return orig.apply(GestureModule, args);
            }
        });

        this.patches.push(tapPatch);
        logger.log("BetterChatGestures: Chargé et opérationnel.");
    },

    onUnload() {
        this.patches.forEach(p => p());
        this.patches = [];
        GestureModule = null;
        isHandlingGesture = false;
    },

    settings: Settings
};

export default BetterChatGestures;
