
"use strict";

/**
 * Centralized application constants.
 */
export class Constants {
    // ============================================================
    // Application
    // ============================================================

    /**
     * Maximum idle time before a client is considered disconnected.
     */
    static MAX_IDLE_MS = 30 * 1000;

    /**
     * Duration used by short UI countdowns and temporary dismissals.
     */
    static COUNTDOWN_SECONDS = 5;

    /**
     * Number of cards dealt to each player when a game starts.
     */
    static PLAYER_INITIAL_CARD_COUNT = 7;

    /**
     * Maximum number of players allowed in a session.
     */
    static SESSION_MAX_CAPACITY = 4;

    /**
     * Ordered display names for local AI opponents.
     */
    static LOCAL_OPPONENT_NAMES = Object.freeze(["AI 1", "AI 2", "AI 3"]);

    /**
     * Default sessions available in Local and Server registries.
     */
    static DEFAULT_SESSIONS = Object.freeze([
        Object.freeze({name: "Default-S0", capacity: 4, aiCount: 2}),
        Object.freeze({name: "Default-S1", capacity: 4, aiCount: 2}),
        Object.freeze({name: "Default-S2", capacity: 4, aiCount: 1}),
        Object.freeze({name: "Default-S3", capacity: 4, aiCount: 1})
    ]);

    /**
     * Emoji groups used by game messages.
     */
    static EMOJIS = Object.freeze({
        silly: this.#createEmojiGroup(["😂", "🤣", "😈", "👿", "😝", "🙃", "🤪", "😜"]),
        winner: this.#createEmojiGroup(["🏆", "🎉", "🎊"])
    });

    /**
     * Creates an immutable emoji group with random selection.
     *
     * @param {string[]} emojis - Emoji values.
     * @returns {{values:readonly string[], readonly random:string}} Emoji group.
     */
    static #createEmojiGroup(emojis) {
        const values = Object.freeze([...emojis]);
        return Object.freeze({ values, get random(){
            return values[Math.floor(Math.random() * values.length)];
        }});
    }

    // ============================================================
    // Cards
    // ============================================================

    /**
     * Playing card constants.
     */
    static CARD = Object.freeze({
        /**
         * Drag-clone size relative to the rendered source card.
         *
         * For example, .25 renders the drag clone at one quarter size.
         */
        DRAG_CLONE_SCALE: 1.5,

        /**
         * Available card sorting options.
         */
        SORT_OPTIONS: Object.freeze(["none", "rank", "value", "suit", "score"]),

        /**
         * Card values and their natural rank.
         */
        VALUE: Object.freeze({
            TWO: Object.freeze({
                id: "2",
                rank: 2
            }),
            THREE: Object.freeze({
                id: "3",
                rank: 3
            }),
            FOUR: Object.freeze({
                id: "4",
                rank: 4
            }),
            FIVE: Object.freeze({
                id: "5",
                rank: 5
            }),
            SIX: Object.freeze({
                id: "6",
                rank: 6
            }),
            SEVEN: Object.freeze({
                id: "7",
                rank: 7
            }),
            EIGHT: Object.freeze({
                id: "8",
                rank: 8
            }),
            NINE: Object.freeze({
                id: "9",
                rank: 9
            }),
            TEN: Object.freeze({
                id: "10",
                rank: 10
            }),
            JACK: Object.freeze({
                id: "j",
                rank: 11
            }),
            QUEEN: Object.freeze({
                id: "q",
                rank: 12
            }),
            KING: Object.freeze({
                id: "k",
                rank: 13
            }),
            ACE: Object.freeze({
                id: "a",
                rank: 14
            }),
            JOKER: Object.freeze({
                id: "joker",
                rank: 15
            })
        }),

        /**
         * Card suits.
         */
        SUIT: Object.freeze({
            CLUBS: "clubs",
            DIAMONDS: "diamonds",
            HEARTS: "hearts",
            SPADES: "spades",

            BLACK: "black",
            RED: "red"
        }),

        /**
         * Standard suits used by non-joker cards.
         */
        STANDARD_SUITS: Object.freeze(["clubs", "diamonds", "hearts", "spades"]),

        /**
         * Suits reserved for joker cards.
         */
        JOKER_SUITS: Object.freeze(["black", "red"]),

        /**
         * Values used by standard, non-joker cards.
         */
        STANDARD_VALUES: Object.freeze([
            "2", "3", "4", "5", "6", "7", "8", "9", "10", "j", "q", "k", "a"
        ]),

        /**
         * Score overrides for cards whose score differs from natural rank.
         */
        SCORE: Object.freeze({
            TWO: 20,
            SEVEN_OF_HEARTS: 30,
            ACE_OF_SPADES: 40,
            JOKER: 50
        })
    });

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
     * Gets the card definition for a card id.
     *
     * @param {string} id - Card value id.
     * @returns {{id:string, rank:number}}
     * @throws {Error}
     */
    static getCardValue(id) {
        let cardValue = null;

        for (const card of Object.values(Constants.CARD.VALUE)) {
            if (card.id === id) {
                cardValue = card;
                break;
            }
        }

        if (cardValue === null) {
            throw new Error(`Invalid card value: ${id}`);
        }

        return cardValue;
    }

    /**
     * Gets the score for a card value and suit.
     *
     * This is the single source of truth for card scoring.
     *
     * @param {string} value - Card value id.
     * @param {string} suit - Card suit.
     * @returns {number} Card score.
     * @throws {Error}
     */
    static getCardScore(value, suit) {
        let score = Constants.getCardValue(value).rank;

        if (value === Constants.CARD.VALUE.JOKER.id) {
            score = Constants.CARD.SCORE.JOKER;
        } else if (value === Constants.CARD.VALUE.TWO.id) {
            score = Constants.CARD.SCORE.TWO;
        } else if (value === Constants.CARD.VALUE.SEVEN.id && suit === Constants.CARD.SUIT.HEARTS) {
            score = Constants.CARD.SCORE.SEVEN_OF_HEARTS;
        } else if (value === Constants.CARD.VALUE.ACE.id && suit === Constants.CARD.SUIT.SPADES) {
            score = Constants.CARD.SCORE.ACE_OF_SPADES;
        }

        return score;
    }

    // ============================================================
    // Status
    // ============================================================

    /**
     * Application status values.
     */
    static STATUS = Object.freeze({
        WAITING: "waiting",
        STARTING: "starting",
        PLAYING: "playing",
        PENDING: "pending",
        FINISHED: "finished",

        CONNECTING: "connecting",
        CONNECTED: "connected",
        DISCONNECTED: "disconnected",

        INFO: "info",
        WARNING: "warning",
        ERROR: "error"
    });

    // ============================================================
    // Views
    // ============================================================

    /**
     * Application views.
     */
    static VIEWS = Object.freeze({
        GAME: "game",
        SESSION: "session"
    });

    // ============================================================
    // Actions
    // ============================================================

    /**
     * User actions dispatched by the client.
     * These actions are also sent to the server.
     */
    static ACTIONS = Object.freeze({
        LIST: "list",
        CREATE: "create",
        VIEW: "view",
        JOIN: "join",
        LEAVE: "leave",
        START: "start",
        PASS: "pass",
        DRAW: "draw",
        DISCARD: "discard",
        DECLARE: "declare"
    });

    // ============================================================
    // Server Responses
    // ============================================================

    /**
     * Top-level fields included in every server response.
     */
    static RESPONSE_KEYS = Object.freeze({
        VIEW: "view",
        MESSAGE: "message",
        SYNC: "sync"
    });
}
