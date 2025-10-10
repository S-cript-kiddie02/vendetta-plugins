import { patcher } from "vendetta";
import { findByProps, findByName } from "vendetta/metro";
import { fluxDispatcher } from "vendetta/metro/common";
import { ReactNative, React } from "vendetta/metro/common";
import { Gesture, GestureDetector } from "react-native-gesture-handler";

const Messages = findByProps("startEditMessage");
const UserStore = findByProps("getCurrentUser");
// NOUVEAU : On cherche le module qui gère les réactions
const ReactionModule = findByProps("addReaction", "removeReaction");

// NOUVEAU : Notre "drapeau" pour bloquer la réaction native
let justHandledDoubleTap = false;

export default {
    onLoad: () => {
        // Patch pour notre geste personnalisé (votre code existant, légèrement modifié)
        const chatMessagePatch = patcher.after("render", findByName("ChatMessage", false), ([{ message, channel }], res) => {
            const doubleTapGesture = Gesture.Tap()
                .numberOfTaps(2)
                .maxDelay(250) // Délai raisonnable pour un double tap
                .onEnd((_tap, success) => {
                    if (success) {
                        // NOUVEAU : On lève notre drapeau
                        justHandledDoubleTap = true;
                        // On met une sécurité pour réinitialiser le drapeau après un court instant, 
                        // au cas où le patch de réaction ne s'exécuterait pas.
                        setTimeout(() => { justHandledDoubleTap = false; }, 100);

                        if (message.author.id === UserStore.getCurrentUser().id) {
                            Messages.startEditMessage(channel.id, message.id, message.content);
                        } else {
                            fluxDispatcher.dispatch({
                                type: "MESSAGE_START_REPLY",
                                channel,
                                message,
                                showMention: true,
                            });
                        }
                    }
                });

            return (
                <GestureDetector gesture={doubleTapGesture}>
                    {res}
                </GestureDetector>
            );
        });

        // NOUVEAU : Le patch pour intercepter et bloquer la réaction native
        const reactionPatch = patcher.before("addReaction", ReactionModule, (args) => {
            // Si notre drapeau est levé, cela signifie que notre plugin vient de s'exécuter.
            if (justHandledDoubleTap) {
                // On réinitialise le drapeau
                justHandledDoubleTap = false;
                // En retournant 'false', on annule l'exécution de la fonction originale "addReaction"
                return false; 
            }
            // Sinon, on laisse la fonction s'exécuter normalement
            return args;
        });

        // On stocke les deux "unpatchers" pour pouvoir les retirer proprement
        this.unpatch = () => {
            chatMessagePatch();
            reactionPatch();
        };
    },

    onUnload: () => {
        this.unpatch?.();
    },
};
