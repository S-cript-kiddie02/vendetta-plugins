import { findByProps } from "@vendetta/metro";
import { before } from "@vendetta/patcher";
import { logger } from "@vendetta";
import Settings from "./components/Settings";

// Le Dispatcher est le cœur de Discord, il existe forcément.
const FluxDispatcher = findByProps("dispatch", "subscribe");

const BetterChatGestures = {
    patches: [],

    onLoad() {
        logger.log("🧠 FLUX SPY: Démarrage...");

        if (!FluxDispatcher) {
            logger.error("🧠 FLUX SPY: Impossible de trouver le Dispatcher (C'est très grave)");
            return;
        }

        // On intercepte TOUS les événements qui passent
        const patch = before("dispatch", FluxDispatcher, (args) => {
            const event = args[0];
            
            // On filtre pour ne pas spammer tes logs avec des trucs inutiles (typing, présence...)
            // On cherche tout ce qui touche aux réactions ou aux gestes
            if (event && event.type) {
                const type = event.type;
                
                if (type.includes("REACTION") || type.includes("TAP") || type.includes("GESTURE")) {
                    logger.log(`🚨 FLUX EVENT DÉTECTÉ: ${type}`);
                    // On affiche le contenu pour être sûr
                    console.log(event); 
                }
            }
        });

        this.patches.push(patch);
        logger.log("🧠 FLUX SPY: En écoute. Fais ton double tap maintenant !");
    },

    onUnload() {
        this.patches.forEach(p => p());
        this.patches = [];
    },

    settings: Settings
};

export default BetterChatGestures;
