// === IMPORTATIONS CORRIGÉES ET MODERNISÉES ===
import { patcher } from "@vendetta/patcher";
import { findByProps, findByName } from "@vendetta/metro";
import { FluxDispatcher, React, ReactNative } from "@vendetta/metro/common"; // Note: FluxDispatcher avec une majuscule
import { logger } from "@vendetta/logger";
import { Gesture, GestureDetector } from "react-native-gesture-handler";

// Le reste du code est quasi identique, mais utilise les modules importés correctement

const Messages = findByProps("startEditMessage");
const UserStore = findbyProps("getCurrentUser");

let justHandledDoubleTap = false;

export default {
    onLoad: () => {
        logger.log("BetterBetterChatGesturesV3: Plugin loading...");

        // === 1. PATCH DU GESTE SUR LES MESSAGES (Partie principale) ===
        try {
            const chatMessagePatch = patcher.after("render", findByName("ChatMessage", false), ([{ message, channel }], res) => {
                if (!message || !channel) return res;

                const doubleTapGesture = Gesture.Tap()
                    .numberOfTaps(2)
                    .maxDelay(250)
                    .onEnd((_tap, success) => {
                        if (success) {
                            justHandledDoubleTap = true;
                            setTimeout(() => { justHandledDoubleTap = false; }, 100);

                            if (message.author.id === UserStore.getCurrentUser().id) {
                                Messages.startEditMessage(channel.id, message.id, message.content);
                            } else {
                                // On utilise FluxDispatcher avec une majuscule
                                FluxDispatcher.dispatch({
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
            this.chatMessageUnpatch = chatMessagePatch;
            logger.log("BetterBetterChatGesturesV3: ChatMessage component patched successfully.");

        } catch (e) {
            logger.error("BetterBetterChatGesturesV3: FAILED to patch ChatMessage component.", e);
            return;
        }


        // === 2. PATCH ANTI-RÉACTION (Partie corrective) ===
        try {
            const ReactionModule = findByProps("addReaction", "removeReaction");

            if (ReactionModule) {
                const reactionPatch = patcher.before("addReaction", ReactionModule, () => {
                    if (justHandledDoubleTap) {
                        justHandledDoubleTap = false;
                        return false;
                    }
                });
                this.reactionUnpatch = reactionPatch;
                logger.log("BetterBetterChatGesturesV3: ReactionModule patched successfully. Anti-reaction fix is active.");
            } else {
                logger.warn("BetterBetterChatGesturesV3: Could not find ReactionModule. The anti-reaction fix is disabled. First double-tap may still trigger a reaction.");
            }

        } catch (e) {
            logger.error("BetterBetterChatGesturesV3: An error occurred while trying to patch ReactionModule.", e);
        }
    },

    onUnload: () => {
        logger.log("BetterBetterChatGesturesV3: Plugin unloading...");
        this.chatMessageUnpatch?.();
        this.reactionUnpatch?.();
    },
};
