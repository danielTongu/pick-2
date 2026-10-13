/** Canonical immutable vocabulary, limits, card definitions, and timing shared across Pick 2. */
export class Constants {

    // ---- Server and timing ----

    /** @type {string} Hosted server origin; empty selects Direct mode. */
    static GAME_SERVER_ORIGIN = "http://localhost:8080";

    /** @type {number} Hosted connection attempt timeout. */
    static CONNECTION_PROBE_TIMEOUT_MS = 3 * 1000;

    /** @type {number} Room wait for player activity, empty-room closure, and the next Knockout match. */
    static ROOM_WAIT_MS = 30 * 1000;

    /** @type {number} Transition countdown length. */
    static COUNTDOWN_SECONDS = 5;

    /** @type {number} Minimum automated-turn delay. */
    static AUTOMATED_PLAYER_DELAY_MIN_MS = 2000;

    /** @type {number} Maximum automated-turn delay.*/
    static AUTOMATED_PLAYER_DELAY_MAX_MS = 4000;

    // ---- Statuses and states ----

    /** @type {Readonly<Record<string, string>>} Connection and notification statuses. */
    static STATUS = Object.freeze({
        CONNECTING: "connecting", CONNECTED: "connected", DISCONNECTED: "disconnected", UNCONFIGURED: "unconfigured", INFO: "info", WARNING: "warning", ERROR: "error"
    });

    /** @type {Readonly<Record<string, string>>} Room lifecycle states. */
    static ROOM_STATE = Object.freeze({ WAITING: "waiting", ACTIVE: "active", FINISHED: "finished" });

    /** @type {Readonly<Record<string, string>>} Player match states. */
    static PLAYER_STATE = Object.freeze({ READY: "ready", ACTIVE: "active", WON: "won", LOST: "lost", QUALIFIED: "qualified", ELIMINATED: "eliminated" });

    /** Room-table Knockout column values. */
    static KNOCKOUT_VALUE = Object.freeze({ YES: "yes", NO: "no" });

    /** Play choice dialog's data-state values. */
    static PLAY_DIALOG_STATE = Object.freeze({ OPEN: "open", CLOSED: "closed" });

    // ---- Views and commands ----

    /** @type {Readonly<Record<string, string>>} Application views.*/
    static VIEWS = Object.freeze({ HOME: "home", ROOM: "room", CONNECTION: "connection" });

    /** @type {Readonly<Record<string,string>>} Canonical request command names accepted by Host. */
    static COMMANDS = Object.freeze({
        LIST: "list",
        CREATE: "create",
        VIEW: "view",
        JOIN: "join",
        LEAVE: "leave",
        START: "start",
        DRAW: "draw",
        PASS: "pass",
        DISCARD: "discard",
        DECLARE: "declare"
    });

    /** @type {Readonly<Record<string, string>>} Top-level response fields. */
    static RESPONSE_KEYS = Object.freeze({ VIEW: "view", MESSAGE: "message", DATA: "data" });

    // ---- Card definitions ----

    /** @type {Readonly<Object>} Canonical card ranks, values, suits, deck membership, and sort options. */
    static CARD = this.#createCardDefinitions({
        RANK: Object.freeze({ SEVEN_OF_HEARTS: 30, ACE_OF_SPADES: 50 }),

        /** Available card sorting options. */
        SORT_OPTIONS: Object.freeze(["none", "rank", "suit"]),

        /** Card values and their default Pick 2 rank. */
        VALUE: Object.freeze({
            TWO: Object.freeze({ id: "2", rank: 20 }),
            THREE: Object.freeze({ id: "3", rank: 3 }),
            FOUR: Object.freeze({ id: "4", rank: 4 }),
            FIVE: Object.freeze({ id: "5", rank: 5 }),
            SIX: Object.freeze({ id: "6", rank: 6 }),
            SEVEN: Object.freeze({ id: "7", rank: 7 }),
            EIGHT: Object.freeze({ id: "8", rank: 8 }),
            NINE: Object.freeze({ id: "9", rank: 9 }),
            TEN: Object.freeze({ id: "10", rank: 10 }),
            JACK: Object.freeze({ id: "j", rank: 11 }),
            QUEEN: Object.freeze({ id: "q", rank: 12 }),
            KING: Object.freeze({ id: "k", rank: 13 }),
            ACE: Object.freeze({ id: "a", rank: 14 }),
            JOKER: Object.freeze({ id: "joker", rank: 40 })
        }),

        /** Card suits. */
        SUIT: Object.freeze({
            CLUBS: "clubs",
            DIAMONDS: "diamonds",
            HEARTS: "hearts",
            SPADES: "spades",

            BLACK: "black",
            RED: "red"
        })
    });

    // ---- Room defaults ----

    /** @type {number} Default maximum players per room. */
    static ROOM_PLAYER_LIMIT = 4;

    /** @type {number} Default number of cards dealt to each player. */
    static INITIAL_ITEM_COUNT = 7;

    /** Ordered display names for Direct bot opponents.*/
    static DIRECT_OPPONENT_NAMES = Object.freeze(["CM", "XC", "VI"]);

    /** Default rooms available in Direct and Hosted registries.*/
    static DEFAULT_ROOMS = Object.freeze([
        Object.freeze({ roomName: "Default-R0", playerLimit: 4, botCount: 3 }),
        Object.freeze({ roomName: "Default-R1", playerLimit: 4, botCount: 2 }),
        Object.freeze({ roomName: "Default-R2", playerLimit: 4, botCount: 1 })
    ]);

    // ---- Notifications ----

    /** Canonical notification headings and messages shown by the game and room interfaces. */
    static NOTIFICATIONS = Object.freeze({
        VIEWER_WELCOME: Object.freeze({
            title: "welcome in!",
            message: "You’re viewing the room you selected.\nClick the JOIN button to participate."
        }),
        PLAYER_WELCOME: Object.freeze({
            title: "welcome",
            message: "You are now a player.\nSee FAQ for the game guide.\n\nGood luck!"
        }),
        MOVED_TO_VIEWING: Object.freeze({ title: "Moved to viewing", message: "You were idle." }),
        ROOM_CLOSED: Object.freeze({ title: "Room closed", message: "No players remain." }),
        INVITE_COPIED: Object.freeze({
            title: "Invite copied",
            message: "Paste the room link wherever you want to share it."
        }),
        COPY_FAILED: Object.freeze({
            title: "Copy failed",
            message: "Copy the address from your browser instead."
        }),
        ROOM_NOT_FOUND: Object.freeze({ title: "Room not found", message: "Check the room name and try again." }),
        ROOM_ALREADY_EXISTS: Object.freeze({
            title: "Room already exists",
            message: "Choose another name or join the existing room."
        }),
        CARDS_DRAWN_TITLE: "Cards drawn",
        INVALID_NAME_TITLE: "Invalid name",
        ERROR_TITLE: "Error"
    });

    /** Emoji groups used by room messages. */
    static EMOJIS = Object.freeze({
        silly: this.#createEmojiGroup(["😈", "😂", "😝", "🙃", "🤪"])
    });

    // ---- Card helpers ----

    /**
     * Derives immutable deck lists from the canonical card definitions.
     * @param {Object} definitions - Card ranks, values, suits, and sort options.
     * @returns {Readonly<Object>} Card definitions with ordered deck lists.
     */
    static #createCardDefinitions(definitions) {
        const suits = definitions.SUIT;
        const standardValues = [];

        for (const value of Object.values(definitions.VALUE)) {
            if (value !== definitions.VALUE.JOKER) {
                standardValues.push(value.id);
            }
        }

        return Object.freeze({
            ...definitions,
            STANDARD_SUITS: Object.freeze([suits.CLUBS, suits.DIAMONDS, suits.HEARTS, suits.SPADES]),
            JOKER_SUITS: Object.freeze([suits.BLACK, suits.RED]),
            STANDARD_VALUES: Object.freeze(standardValues)
        });
    }

    /**
     * Checks whether a value identifies a standard non-joker suit.
     *
     * @param {*} suit - Value to inspect.
     * @returns {boolean} Whether the value is a standard suit.
     */
    static isStandardSuit(suit) {
        return Constants.CARD.STANDARD_SUITS.includes(suit);
    }

    /**
     * Checks whether a value identifies a joker suit.
     *
     * @param {*} suit - Value to inspect.
     * @returns {boolean} Whether the value is a joker suit.
     */
    static isJokerSuit(suit) {
        return Constants.CARD.JOKER_SUITS.includes(suit);
    }

    /**
     * Normalizes and validates a standard non-joker suit.
     *
     * @param {*} value - Suit value.
     * @returns {string} Normalized standard suit.
     * @throws {Error} When the value is not a standard suit.
     */
    static normalizeStandardSuit(value) {
        const suit = typeof value === "string" ? value.trim().toLowerCase() : "";

        if (!Constants.isStandardSuit(suit)) {
            throw new Error(`Invalid suit: ${suit}`);
        }

        return suit;
    }

    /**
     * Resolves an immutable value definition by its canonical card identifier.
     *
     * @param {string} id - Card value id.
     * @returns {{id:string, rank:number}}
     * @throws {Error} When the identifier does not match a configured card value.
     */
    static getCardValue(id) {
        for (const card of Object.values(Constants.CARD.VALUE)) {
            if (card.id === id) {
                return card;
            }
        }

        throw new Error(`Invalid card value: ${id}`);
    }

    /**
     * Returns the Pick 2 rank for a validated card identity.
     * @param {string} value - Card value.
     * @param {string} suit - Card suit.
     * @returns {number} Rank for the card.
     */
    static getCardRank(value, suit) {
        let rank = Constants.getCardValue(value).rank;

        if (value === Constants.CARD.VALUE.SEVEN.id && suit === Constants.CARD.SUIT.HEARTS) {
            rank = Constants.CARD.RANK.SEVEN_OF_HEARTS;
        } else if (value === Constants.CARD.VALUE.ACE.id && suit === Constants.CARD.SUIT.SPADES) {
            rank = Constants.CARD.RANK.ACE_OF_SPADES;
        }

        return rank;
    }

    // ---- Emoji helpers ----

    /**
     * Creates an immutable emoji group with random selection.
     *
     * @param {string[]} emojis - Emoji values.
     * @returns {{values:readonly string[], readonly random:string}} Emoji group.
     */
    static #createEmojiGroup(emojis) {
        const values = Object.freeze([...emojis]);
        return Object.freeze({
            values,
            get random() {
                return values[Math.floor(Math.random() * values.length)];
            }
        });
    }
}
