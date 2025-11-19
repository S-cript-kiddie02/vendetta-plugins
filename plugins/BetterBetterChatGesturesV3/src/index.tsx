import { findByProps, findByStoreName } from "@vendetta/metro";
import { ReactNative } from "@vendetta/metro/common";
import { instead, after } from "@vendetta/patcher";
import { storage, manifest } from "@vendetta/plugin";
import Settings from "./components/Settings";
import { logger } from "@vendetta";

// --- MODULES ---
const ChannelStore = findByStoreName("ChannelStore");
const MessageStore = findByStoreName("MessageStore");
const UserStore = findByStoreName("UserStore");
const Messages = findByProps("sendMessage", "startEditMessage");
const ReplyManager = findByProps("createPendingReply");
// Pour ouvrir le clavier (méthode simple)
const ChatInputRef = findByProps("insertText");

// --- RECHERCHE DU MODULE HANDLERS ---
let MessagesHandlersModule = findByProps("MessagesHandlers");

if (!MessagesHandlersModule) {
    logger.warn("DEBUG: MessagesHandlers introuvable via props, tentative via cache...");
    const allModules = window.vendetta?.metro?.cache || new Map();
    for (const [key, module] of allModules) {
        if (module?.exports?.MessagesHandlers) {
            MessagesHandlersModule = module.exports;
            break;
        }
    }
}

const MessagesHandlers = MessagesHandlersModule?.MessagesHandlers;

// --- HELPER ---
function openKeyboard() {
    try {
        const ChatInput = ChatInputRef?.refs?.[0]?.current;
        if (ChatInput?.focus) ChatInput.focus();
    } catch (e) { console.log(e) }
}

const BetterChatGestures = {
    patches: [],
    handlersPatched: new WeakSet(), // Pour éviter de patcher 2 fois la même instance

    // Cette fonction applique le patch sur une instance spécifique de handlers
    applyPatchToInstance(instance, origin) {
        if (this.handlersPatched.has(instance)) return;
        this.handlersPatched.add(instance);
        
        logger.log(`DEBUG: Patching instance venant de ${origin}`);

        // 1. Patch du DOUBLE TAP
        if (instance.handleDoubleTapMessage) {
            const patch = instead("handleDoubleTapMessage", instance, (args, orig) => {
                logger.log("DEBUG: handleDoubleTapMessage DÉCLENCHÉ !");
                
                try {
                    const event = args[0];
                    // Vérification basique
                    if (!event || !event.nativeEvent) {
                        logger.log("DEBUG: Pas de nativeEvent, on bloque.");
                        return true; 
                    }

                    const { channelId, messageId } = event.nativeEvent;
                    logger.log(`DEBUG: DoubleTap détecté sur MsgID: ${messageId}`);

                    const message = MessageStore.getMessage(channelId, messageId);
                    const channel = ChannelStore.getChannel(channelId);
                    const currentUser = UserStore.getCurrentUser();

                    if (!message || !currentUser) {
                         logger.log("DEBUG: Message ou User introuvable");
                         return true;
                    }

                    const isAuthor = message.author.id === currentUser.id;
                    logger.log(`DEBUG: Auteur ? ${isAuthor} | Action: ${isAuthor ? "Edit" : "Reply"}`);

                    // ACTION
                    if (isAuthor && storage.userEdit) {
                        Messages.startEditMessage(channelId, messageId, message.content || "");
                    } else if (storage.reply) {
                        ReplyManager.createPendingReply({ channel, message, shouldMention: true });
                    }

                    openKeyboard();
                    
                    logger.log("DEBUG: Action terminée, return true pour bloquer Discord.");
                    return true; // BLOQUE LA RÉACTION

                } catch (e) {
                    logger.error("DEBUG: Crash dans le patch", e);
                    return true; // En cas d'erreur, on bloque quand même
                }
            });
            this.patches.push(patch);
        } else {
            logger.warn("DEBUG: L'instance ne possède pas handleDoubleTapMessage !");
        }
    },

    onLoad() {
        logger.log("DEBUG: Plugin Loaded");

        if (!MessagesHandlers) {
            logger.error("DEBUG: FATAL - MessagesHandlers class introuvable.");
            return;
        }

        // Paramètres par défaut
        storage.reply ??= true;
        storage.userEdit ??= true;

        const self = this;

        // On essaie de patcher le prototype directement pour attraper les futures créations
        // On cherche le "getter" qui renvoie les params (souvent 'params' ou 'handlers')
        const proto = MessagesHandlers.prototype;
        const possibleGetters = ["params", "handlers", "_params"];
        let foundGetter = false;

        for (const prop of possibleGetters) {
            const descriptor = Object.getOwnPropertyDescriptor(proto, prop);
            if (descriptor && descriptor.get) {
                logger.log(`DEBUG: Getter trouvé sur '${prop}'`);
                foundGetter = true;
                
                // On remplace le getter
                const originalGetter = descriptor.get;
                Object.defineProperty(proto, prop, {
                    configurable: true,
                    get() {
                        const result = originalGetter.call(this);
                        // Dès qu'on récupère les handlers, on les patch
                        if (result) {
                            self.applyPatchToInstance(result, `getter:${prop}`);
                        }
                        return result;
                    }
                });

                // Nettoyage à la fermeture
                this.patches.push(() => {
                    Object.defineProperty(proto, prop, {
                        configurable: true,
                        get: originalGetter
                    });
                });
                break; // On a trouvé, on arrête
            }
        }

        if (!foundGetter) {
            logger.error("DEBUG: Aucun getter trouvé sur le prototype ! Le patch global a échoué.");
        }
    },

    onUnload() {
        logger.log("DEBUG: Unloading...");
        this.patches.forEach(p => p());
        this.patches = [];
        this.handlersPatched = new WeakSet();
    },

    settings: Settings
};

export default BetterChatGestures;
