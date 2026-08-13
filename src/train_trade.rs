//! Corporation-to-corporation train sales -- Audit G-15.
//!
//! # The rule
//!
//! During its Hardware phase a corporation may buy a train from ANOTHER
//! corporation, at any price of $1 or more, instead of (or as well as) buying
//! from the Bank. There is no upper bound: in 1830 a president who controls
//! both companies routinely moves a train for $1 to strand a rival, or for a
//! company's entire treasury to shift money between his own corporations.
//! That is a legitimate and central part of the game, not an exploit.
//!
//! # Two paths, because consent only matters across players
//!
//! **Same president -- executes immediately.** If one human is president of
//! both corporations, there is no counterparty to negotiate with. Requiring
//! them to offer a train to themselves and then accept it would be two
//! transactions to express one decision they have already made alone.
//!
//! **Different presidents -- an offer the seller answers.** The buyer's
//! president records an offer; the seller's president accepts or rejects it.
//! The buyer may rescind at any time before it is answered.
//!
//! # The offer does NOT block the Operating Round
//!
//! A pending offer never stalls the turn. The buying corporation may buy from
//! the Bank instead, or simply end its turn; the seller answers whenever they
//! next act.
//!
//! This is a deliberate departure from the tabletop, where the table waits
//! while two players haggle. On-chain the table cannot wait: one player who
//! steps away would freeze the room indefinitely, and there is no honest
//! timeout -- block-time-driven auto-rejection would make the game log
//! non-deterministic to replay, which `gamelog::reapply_game_log` depends on.
//! So the offer is a standing proposition rather than an interrupt, and
//! `RescindTrainOffer` exists precisely because it can outlive the moment.
//!
//! # Everything is re-validated at ACCEPT, not at offer
//!
//! An offer is a proposition, not a reservation. Between making one and
//! answering it, the buyer may have spent its treasury, bought a train from
//! the Bank and hit its train limit, or had the train rust out from under the
//! seller. So acceptance re-checks: the seller still owns that model, the
//! buyer can still pay, and the buyer is still under its train limit. A stale
//! offer fails at acceptance rather than transferring something impossible.
//!
//! Nothing is escrowed. Reserving the buyer's VGP at offer time would let a
//! player freeze their own treasury against a rival's acceptance, and would
//! need unwinding on every rescind, reject and expiry path.
//!
//! # A transfer is NOT a purchase
//!
//! Deliberately does NOT call `hardware::record_purchase_and_apply_rusting`.
//! That helper bumps `TRAINS_PURCHASED_COUNT` and runs the Rusting sweep,
//! both of which are about a train ENTERING PLAY from the Bank. A train sold
//! between corporations was already bought once; counting it again would
//! advance the phase and rust an entire tier out of existence on a move that
//! introduced no new equipment. The train changes hands; the game's phase
//! does not move.
//!
//! # What is deliberately NOT restricted
//!
//! - **Selling your last train.** Legal in 1830. A corporation that strands
//!   itself can recover through the Validator Liability emergency purchase.
//! - **Price ceiling.** None. $1 minimum, nothing above.
//! - **Train limit on the SELLER.** Selling only ever reduces its count.

use cosmwasm_std::{Addr, DepsMut, Env, MessageInfo, Response, StdError, Storage, Uint128};
use thiserror::Error;

use crate::hardware::{highest_train_tier_purchased, train_limit_for_phase};
use crate::or_phase;
use crate::state::{
    GameSession, HardwareAsset, OperatingSubPhase, TrainOffer, COMPANY_HARDWARE,
    NEXT_TRAIN_OFFER_ID, PROTOCOL_PRESIDENT, PUBLIC_COMPANIES, SESSIONS, TRAIN_OFFERS,
};

/// The floor on an inter-corporation train price. A train may not change
/// hands for nothing -- $1 is the token consideration that keeps the move a
/// sale rather than a gift, and it is the real 1830 rule.
pub const MINIMUM_TRAIN_PRICE: u128 = 1;

#[derive(Error, Debug)]
pub enum TrainTradeError {
    #[error("{0}")]
    Std(#[from] StdError),

    #[error("Game room {game_id} was not found")]
    GameNotFound { game_id: u64 },

    #[error("Game room {game_id} is not active")]
    GameNotActive { game_id: u64 },

    #[error("Protocol {protocol_id} has no registered President")]
    NoPresidentAssigned { protocol_id: u32 },

    #[error("Unauthorized: only protocol {protocol_id}'s registered President may act for it")]
    NotPresident { protocol_id: u32 },

    #[error("A corporation cannot buy a train from itself (protocol {protocol_id})")]
    SelfTrade { protocol_id: u32 },

    #[error(
        "A train must sell for at least ${minimum}; {price} was offered"
    )]
    PriceBelowMinimum { price: Uint128, minimum: u128 },

    #[error("Protocol {seller_protocol_id} owns no {model_type}-train to sell")]
    SellerHasNoSuchTrain {
        seller_protocol_id: u32,
        model_type: String,
    },

    #[error(
        "Protocol {buyer_protocol_id} already holds {owned} train(s), its limit in phase {phase} -- it cannot take another"
    )]
    BuyerAtTrainLimit {
        buyer_protocol_id: u32,
        owned: u32,
        limit: u32,
        phase: String,
    },

    #[error(
        "Protocol {buyer_protocol_id}'s treasury holds {available}, short of the {required} agreed price"
    )]
    BuyerCannotAfford {
        buyer_protocol_id: u32,
        required: Uint128,
        available: Uint128,
    },

    #[error("Train offer {offer_id} was not found in game room {game_id}")]
    OfferNotFound { game_id: u64, offer_id: u64 },

    #[error(
        "Train offer {offer_id} is protocol {buyer_protocol_id}'s to rescind, not yours"
    )]
    NotOfferer {
        offer_id: u64,
        buyer_protocol_id: u32,
    },

    #[error("Protocol {company_id} was not found in game room {game_id}")]
    PublicCompanyNotFound { game_id: u64, company_id: u32 },

    #[error("Arithmetic overflow")]
    Overflow {},
}

/// Loads an active session or fails.
fn load_active_session(
    storage: &dyn Storage,
    game_id: u64,
) -> Result<GameSession, TrainTradeError> {
    let session: GameSession = SESSIONS
        .may_load(storage, game_id)?
        .ok_or(TrainTradeError::GameNotFound { game_id })?;
    if !session.is_active {
        return Err(TrainTradeError::GameNotActive { game_id });
    }
    Ok(session)
}

/// The registered president of `protocol_id`, or an error.
fn president_of(
    storage: &dyn Storage,
    game_id: u64,
    protocol_id: u32,
) -> Result<Addr, TrainTradeError> {
    PROTOCOL_PRESIDENT
        .may_load(storage, (game_id, protocol_id))?
        .ok_or(TrainTradeError::NoPresidentAssigned { protocol_id })
}

/// Removes one unit of `model_type` from `seller`'s roster and returns it.
fn take_train(
    storage: &mut dyn Storage,
    game_id: u64,
    seller_protocol_id: u32,
    model_type: &str,
) -> Result<HardwareAsset, TrainTradeError> {
    let mut owned = COMPANY_HARDWARE
        .may_load(storage, (game_id, seller_protocol_id))?
        .unwrap_or_default();
    let index = owned
        .iter()
        .position(|unit| unit.model_type == model_type)
        .ok_or_else(|| TrainTradeError::SellerHasNoSuchTrain {
            seller_protocol_id,
            model_type: model_type.to_string(),
        })?;
    let asset = owned.remove(index);
    COMPANY_HARDWARE.save(storage, (game_id, seller_protocol_id), &owned)?;
    Ok(asset)
}

/// Rejects a buyer already at its train limit.
///
/// Uses the phase as it stands, exactly as `execute_buy_hardware_from_pool`
/// does -- an inter-corporation purchase is subject to the same cap as a Bank
/// purchase, since the cap is about how many trains a corporation may HOLD,
/// not where they came from.
fn assert_buyer_under_train_limit(
    storage: &dyn Storage,
    game_id: u64,
    buyer_protocol_id: u32,
) -> Result<(), TrainTradeError> {
    let owned = COMPANY_HARDWARE
        .may_load(storage, (game_id, buyer_protocol_id))?
        .unwrap_or_default()
        .len() as u32;
    let phase = highest_train_tier_purchased(storage, game_id)?;
    let limit = train_limit_for_phase(phase.as_deref());
    if owned >= limit {
        return Err(TrainTradeError::BuyerAtTrainLimit {
            buyer_protocol_id,
            owned,
            limit,
            phase: phase.unwrap_or_else(|| "2 (none purchased yet)".to_string()),
        });
    }
    Ok(())
}

/// Moves one `model_type` train from seller to buyer and `price` VGP the
/// other way. The single settlement path -- both the same-president
/// immediate sale and the accepted cross-player offer land here, so the two
/// cannot diverge on validation or on what a completed trade does.
#[allow(clippy::too_many_arguments)]
fn settle_trade(
    storage: &mut dyn Storage,
    game_id: u64,
    buyer_protocol_id: u32,
    seller_protocol_id: u32,
    model_type: &str,
    price: Uint128,
) -> Result<HardwareAsset, TrainTradeError> {
    assert_buyer_under_train_limit(storage, game_id, buyer_protocol_id)?;

    let mut buyer = PUBLIC_COMPANIES
        .may_load(storage, (game_id, buyer_protocol_id))?
        .ok_or(TrainTradeError::PublicCompanyNotFound {
            game_id,
            company_id: buyer_protocol_id,
        })?;
    let mut seller = PUBLIC_COMPANIES
        .may_load(storage, (game_id, seller_protocol_id))?
        .ok_or(TrainTradeError::PublicCompanyNotFound {
            game_id,
            company_id: seller_protocol_id,
        })?;

    buyer.treasury =
        buyer
            .treasury
            .checked_sub(price)
            .map_err(|_| TrainTradeError::BuyerCannotAfford {
                buyer_protocol_id,
                required: price,
                available: buyer.treasury,
            })?;
    seller.treasury = seller
        .treasury
        .checked_add(price)
        .map_err(|_| TrainTradeError::Overflow {})?;

    // The train moves only after both treasuries have been proven to work, so
    // a failed payment can never leave a train in limbo.
    let asset = take_train(storage, game_id, seller_protocol_id, model_type)?;

    let mut buyer_owned = COMPANY_HARDWARE
        .may_load(storage, (game_id, buyer_protocol_id))?
        .unwrap_or_default();
    buyer_owned.push(asset.clone());
    COMPANY_HARDWARE.save(storage, (game_id, buyer_protocol_id), &buyer_owned)?;

    PUBLIC_COMPANIES.save(storage, (game_id, buyer_protocol_id), &buyer)?;
    PUBLIC_COMPANIES.save(storage, (game_id, seller_protocol_id), &seller)?;

    // NOTE the absence of `record_purchase_and_apply_rusting` -- see the
    // module doc. VGP moves between two treasuries and never touches
    // `virtual_bank_vgp`; no new train entered play, so no phase advance and
    // no Rusting sweep.
    Ok(asset)
}

/// `BuyTrainFromCorporation`. Same president settles immediately; different
/// presidents record an offer for the seller to answer.
pub fn execute_buy_train_from_corporation(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    game_id: u64,
    buyer_protocol_id: u32,
    seller_protocol_id: u32,
    model_type: String,
    price: Uint128,
) -> Result<Response, TrainTradeError> {
    let mut session = load_active_session(deps.storage, game_id)?;

    if buyer_protocol_id == seller_protocol_id {
        return Err(TrainTradeError::SelfTrade {
            protocol_id: buyer_protocol_id,
        });
    }
    if price < Uint128::new(MINIMUM_TRAIN_PRICE) {
        return Err(TrainTradeError::PriceBelowMinimum {
            price,
            minimum: MINIMUM_TRAIN_PRICE,
        });
    }

    let buyer_president = president_of(deps.storage, game_id, buyer_protocol_id)?;
    if info.sender != buyer_president {
        return Err(TrainTradeError::NotPresident {
            protocol_id: buyer_protocol_id,
        });
    }
    let seller_president = president_of(deps.storage, game_id, seller_protocol_id)?;

    // Audit G-14: buying a train is a Hardware-phase action wherever the
    // train comes from, so the same sub-phase gate applies.
    if let Err(mismatch) = or_phase::require_sub_phase(
        deps.storage,
        &session,
        buyer_protocol_id,
        OperatingSubPhase::Hardware,
    ) {
        return Err(match mismatch {
            or_phase::PhaseMismatch::Wrong { actual, required } => {
                TrainTradeError::Std(StdError::generic_err(format!(
                    "protocol {buyer_protocol_id} is in Operating Round phase {} (step {} of 6); buying a train requires phase {} (step {} of 6)",
                    or_phase::phase_name(actual),
                    or_phase::phase_index(actual),
                    or_phase::phase_name(required),
                    or_phase::phase_index(required),
                )))
            }
            or_phase::PhaseMismatch::Storage(message) => {
                TrainTradeError::Std(StdError::generic_err(message))
            }
        });
    }

    // The seller must actually hold the model, whichever path this takes --
    // an offer for a train nobody owns is noise the seller should never see.
    let seller_owns = COMPANY_HARDWARE
        .may_load(deps.storage, (game_id, seller_protocol_id))?
        .unwrap_or_default()
        .iter()
        .any(|unit| unit.model_type == model_type);
    if !seller_owns {
        return Err(TrainTradeError::SellerHasNoSuchTrain {
            seller_protocol_id,
            model_type,
        });
    }

    session.last_action_timestamp = env.block.time.seconds();

    if seller_president == buyer_president {
        // ---- Same human on both sides: no counterparty, settle now. ----
        let asset = settle_trade(
            deps.storage,
            game_id,
            buyer_protocol_id,
            seller_protocol_id,
            &model_type,
            price,
        )?;
        SESSIONS.save(deps.storage, game_id, &session)?;
        return Ok(Response::new()
            .add_attribute("action", "buy_train_from_corporation")
            .add_attribute("settlement", "immediate_same_president")
            .add_attribute("game_id", game_id.to_string())
            .add_attribute("buyer_protocol_id", buyer_protocol_id.to_string())
            .add_attribute("seller_protocol_id", seller_protocol_id.to_string())
            .add_attribute("model_type", asset.model_type)
            .add_attribute("price", price));
    }

    // ---- Different presidents: record an offer for the seller to answer. ----
    let offer_id = NEXT_TRAIN_OFFER_ID
        .may_load(deps.storage, game_id)?
        .unwrap_or(1);
    NEXT_TRAIN_OFFER_ID.save(deps.storage, game_id, &(offer_id + 1))?;

    TRAIN_OFFERS.save(
        deps.storage,
        (game_id, offer_id),
        &TrainOffer {
            offer_id,
            buyer_protocol_id,
            seller_protocol_id,
            model_type: model_type.clone(),
            price,
        },
    )?;
    SESSIONS.save(deps.storage, game_id, &session)?;

    Ok(Response::new()
        .add_attribute("action", "buy_train_from_corporation")
        .add_attribute("settlement", "offer_pending")
        .add_attribute("game_id", game_id.to_string())
        .add_attribute("offer_id", offer_id.to_string())
        .add_attribute("buyer_protocol_id", buyer_protocol_id.to_string())
        .add_attribute("seller_protocol_id", seller_protocol_id.to_string())
        .add_attribute("model_type", model_type)
        .add_attribute("price", price))
}

/// `AcceptTrainOffer` -- the seller's president agrees. Re-validates
/// everything (see the module doc on why an offer is not a reservation).
pub fn execute_accept_train_offer(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    game_id: u64,
    offer_id: u64,
) -> Result<Response, TrainTradeError> {
    let mut session = load_active_session(deps.storage, game_id)?;
    let offer = TRAIN_OFFERS
        .may_load(deps.storage, (game_id, offer_id))?
        .ok_or(TrainTradeError::OfferNotFound { game_id, offer_id })?;

    let seller_president = president_of(deps.storage, game_id, offer.seller_protocol_id)?;
    if info.sender != seller_president {
        return Err(TrainTradeError::NotPresident {
            protocol_id: offer.seller_protocol_id,
        });
    }

    let asset = settle_trade(
        deps.storage,
        game_id,
        offer.buyer_protocol_id,
        offer.seller_protocol_id,
        &offer.model_type,
        offer.price,
    )?;

    TRAIN_OFFERS.remove(deps.storage, (game_id, offer_id));
    session.last_action_timestamp = env.block.time.seconds();
    SESSIONS.save(deps.storage, game_id, &session)?;

    Ok(Response::new()
        .add_attribute("action", "accept_train_offer")
        .add_attribute("game_id", game_id.to_string())
        .add_attribute("offer_id", offer_id.to_string())
        .add_attribute("buyer_protocol_id", offer.buyer_protocol_id.to_string())
        .add_attribute("seller_protocol_id", offer.seller_protocol_id.to_string())
        .add_attribute("model_type", asset.model_type)
        .add_attribute("price", offer.price))
}

/// `RejectTrainOffer` -- the seller's president declines.
pub fn execute_reject_train_offer(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    game_id: u64,
    offer_id: u64,
) -> Result<Response, TrainTradeError> {
    let mut session = load_active_session(deps.storage, game_id)?;
    let offer = TRAIN_OFFERS
        .may_load(deps.storage, (game_id, offer_id))?
        .ok_or(TrainTradeError::OfferNotFound { game_id, offer_id })?;

    let seller_president = president_of(deps.storage, game_id, offer.seller_protocol_id)?;
    if info.sender != seller_president {
        return Err(TrainTradeError::NotPresident {
            protocol_id: offer.seller_protocol_id,
        });
    }

    TRAIN_OFFERS.remove(deps.storage, (game_id, offer_id));
    session.last_action_timestamp = env.block.time.seconds();
    SESSIONS.save(deps.storage, game_id, &session)?;

    Ok(Response::new()
        .add_attribute("action", "reject_train_offer")
        .add_attribute("game_id", game_id.to_string())
        .add_attribute("offer_id", offer_id.to_string()))
}

/// `RescindTrainOffer` -- the BUYER's president withdraws, at any time before
/// the offer is answered.
///
/// Distinct from reject on purpose, even though both just delete the offer:
/// they are different people exercising different rights, and the game log
/// should say which happened. A rescind is the offerer changing their mind; a
/// reject is the counterparty refusing.
pub fn execute_rescind_train_offer(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    game_id: u64,
    offer_id: u64,
) -> Result<Response, TrainTradeError> {
    let mut session = load_active_session(deps.storage, game_id)?;
    let offer = TRAIN_OFFERS
        .may_load(deps.storage, (game_id, offer_id))?
        .ok_or(TrainTradeError::OfferNotFound { game_id, offer_id })?;

    let buyer_president = president_of(deps.storage, game_id, offer.buyer_protocol_id)?;
    if info.sender != buyer_president {
        return Err(TrainTradeError::NotOfferer {
            offer_id,
            buyer_protocol_id: offer.buyer_protocol_id,
        });
    }

    TRAIN_OFFERS.remove(deps.storage, (game_id, offer_id));
    session.last_action_timestamp = env.block.time.seconds();
    SESSIONS.save(deps.storage, game_id, &session)?;

    Ok(Response::new()
        .add_attribute("action", "rescind_train_offer")
        .add_attribute("game_id", game_id.to_string())
        .add_attribute("offer_id", offer_id.to_string()))
}
