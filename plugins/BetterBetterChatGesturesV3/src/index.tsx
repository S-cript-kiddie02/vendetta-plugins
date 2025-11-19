import { findByProps, findByStoreName } from "@vendetta/metro";
import { instead } from "@vendetta/patcher";
import { storage, manifest } from "@vendetta/plugin";
import Settings from "./components/Settings";
import { logger } from "@vendetta";

// --- MODULES UTILES ---
const ChannelStore = findByStoreName("ChannelStore");
const MessageStore = findByStoreName("MessageStore");
const UserStore = findByStoreName("UserStore");
const Messages = findByProps("sendMessage", "startEditMessage");
const ReplyManager = findByProps("createPendingReply");
const ChatInputRef = findByProps("insertText");

// --- RECHERCHE INTELLIGENTE DU BON MODULE ---
// On ne cherche plus par nom, mais par "capacité" (Duck Typing)
// On cherche un module qui sait gérer le clic sur un Avatar
let GesturesModule = findByProps("handleTapAvatar");

// Si non trouvé, on essaie d'autres variantes connues
if (!GesturesModule) {
    GesturesModule = findByProps("handlePressAvatar");
}

// Helper clavier
function openKeyboard() {
    try {
        const ChatInput = ChatInputRef?.refs?.[0]?.current;
        if (ChatInput?.focus) ChatInput.focus();
    } catch (e) {}
}

// Variables pour le double tap manuel
let lastTapTime = 0;
let lastTapMessageId = null;
const DOUBLE_TAP_DELAY = 400; 

const BetterChatGestures = {
    patches: [],
    
    // Cette fonction essaie de deviner quel est le nom de la fonction "Tap Message" dans le module trouvé
    findMessageTapFunctionName(module) {
        const keys = Object.keys(module);
        // On cherche une clé qui ressemble à 'handleTapMessage', 'onMessageTap', etc.
        return keys.find(k => 
            k.toLowerCase().includes("message") && 
            (k.toLowerCase().includes("tap") || k.toLowerCase().includes("press")) &&
            typeof module[k] === "function"
        );
    },

    onLoad() {
        if (!GesturesModule) {
            logger.error("BetterChatGestures: Impossible de trouver le module de gestes (handleTapAvatar introuvable).");
            return;
        }

        // On cherche le nom exact de la fonction qui gère le clic message dans ce module
        const tapFunctionName = this.findMessageTapFunctionName(GesturesModule);

        if (!tapFunctionName) {
            logger.error("BetterChatGestures: Module trouvé, mais impossible d'identifier la fonction de clic message.");
            logger.log("Clés disponibles: " + Object.keys(GesturesModule).join(", "));
            return;
        }

        logger.log(`BetterChatGestures: Cible verrouillée ! Fonction à patcher: ${tapFunctionName}`);

        storage.reply ??= true;
        storage.userEdit ??= true;

        // --- LE PATCH ---
        const patch = instead(tapFunctionName, GesturesModule, (args, orig) => {
            try {
                const event = args[0];
                // Sécurité
                if (!event || !event.nativeEvent) return orig.apply(GesturesModule, args);

                const { messageId, channelId } = event.nativeEvent;
                const now = Date.now();

                // LOGIQUE DOUBLE TAP
                const isSameMessage = messageId === lastTapMessageId;
                const isFastEnough = (now - lastTapTime) < DOUBLE_TAP_DELAY;

                if (isSameMessage && isFastEnough) {
                    logger.log("Double Tap Action!");
                    
                    // Reset
                    lastTapTime = 0;
                    lastTapMessageId = null;

                    const message = MessageStore.getMessage(channelId, messageId);
                    const channel = ChannelStore.getChannel(channelId);
                    const currentUser = UserStore.getCurrentUser();

                    if (message && currentUser) {
                        const isAuthor = message.author.id === currentUser.id;

                        if (isAuthor && storage.userEdit) {
                            Messages.startEditMessage(channelId, messageId, message.content || "");
                        } else if (storage.reply) {
                            ReplyManager.createPendingReply({ channel, message, shouldMention: true });
                        }
                        
                        openKeyboard();
                        return true; // Bloque l'action native (zoom/réaction)
                    }
                }

                // C'est un simple tap
                lastTapTime = now;
                lastTapMessageId = messageId;
                
                return orig.apply(GesturesModule, args);

            } catch (e) {
                logger.error("Error in patch", e);
                return orig.apply(GesturesModule, args);
            }
        });

        this.patches.push(patch);
    },

    onUnload() {
        this.patches.forEach(p => p());
        this.patches = [];
    },

    settings: Settings
};

export default BetterChatGestures;
