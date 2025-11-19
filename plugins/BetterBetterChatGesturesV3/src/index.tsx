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

// Module HTTP pour supprimer la réaction côté serveur (API)
const RestAPI = findByProps("get", "post", "put", "del");

// Le Cerveau (Dispatcher)
const FluxDispatcher = findByProps("dispatch", "subscribe");

// --- HELPERS ---
function openKeyboard() {
    try {
        const ChatInput = ChatInputRef?.refs?.[0]?.current;
        if (ChatInput?.focus) ChatInput.focus();
    } catch (e) {}
}

// Formatter l'emoji pour l'API Discord
function formatEmojiForApi(emoji) {
    if (!emoji) return null;
    if (emoji.id) {
        return `${emoji.name}:${emoji.id}`; // Emoji custom
    }
    return emoji.name; // Emoji unicode
}

const BetterChatGestures = {
    patches: [],

    onLoad() {
        if (!FluxDispatcher || !RestAPI) {
            logger.error("BetterChatGestures: Modules critiques (Dispatcher/HTTP) introuvables.");
            return;
        }

        storage.reply ??= true;
        storage.userEdit ??= true;

        const self = this;
        const currentUser = UserStore.getCurrentUser();

        // --- LE GRAND DÉTOURNEMENT ---
        // On surveille tout ce qui se passe. Si une réaction est ajoutée par "Moi", on agit.
        const dispatchPatch = instead("dispatch", FluxDispatcher, (args, orig) => {
            const event = args[0];
            
            // On cherche un événement d'ajout de réaction
            if (event && event.type === "MESSAGE_REACTION_ADD") {
                
                // Vérification : Est-ce que c'est MOI qui ajoute la réaction ?
                // Note: event.userId est le standard, parfois c'est user_id selon les versions
                const userId = event.userId || event.user_id;
                const meId = currentUser?.id;

                if (userId === meId) {
                    // C'EST UN DÉCLENCHEMENT POTENTIEL !
                    // On considère que tout ajout de réaction est une tentative de geste
                    // (Inconvénient : ça bloquera aussi tes réactions manuelles faites très vite, 
                    // mais c'est le prix à payer pour contourner le bug natif)

                    const { channelId, messageId, emoji } = event;
                    const message = MessageStore.getMessage(channelId, messageId);
                    const channel = ChannelStore.getChannel(channelId);

                    if (message) {
                        const isAuthor = message.author.id === meId;
                        let actionTriggered = false;

                        // 1. Lancer l'action (Edit ou Reply)
                        if (isAuthor && storage.userEdit) {
                            Messages.startEditMessage(channelId, messageId, message.content || "");
                            actionTriggered = true;
                        } else if (storage.reply) {
                            ReplyManager.createPendingReply({ channel, message, shouldMention: true });
                            actionTriggered = true;
                        }

                        if (actionTriggered) {
                            logger.log("BetterChatGestures: Réaction interceptée et convertie en action !");
                            openKeyboard();

                            // 2. NETTOYAGE API (Supprimer la réaction côté serveur)
                            // On envoie une requête DELETE silencieuse
                            const emojiCode = formatEmojiForApi(emoji);
                            if (emojiCode) {
                                RestAPI.del({
                                    url: `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emojiCode)}/@me`
                                }).catch(e => {
                                    // On ignore les erreurs (parfois la réaction n'est même pas encore arrivée au serveur)
                                });
                            }

                            // 3. BLOQUAGE LOCAL (On empêche l'événement d'atteindre l'écran)
                            return; 
                        }
                    }
                }
            }

            return orig.apply(FluxDispatcher, args);
        });

        this.patches.push(dispatchPatch);
        logger.log("BetterChatGestures: Intercepteur de réactions activé.");
    },

    onUnload() {
        this.patches.forEach(p => p());
        this.patches = [];
    },

    settings: Settings
};

export default BetterChatGestures;
