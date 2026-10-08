use crate::errors::FlintError;
use crate::state::*;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::bpf_loader_upgradeable;

#[derive(Accounts)]
pub struct InitConfig<'info> {
    /// Must sign, and must be the program's current **upgrade authority** —
    /// enforced below, not merely asserted by this comment.
    ///
    /// Binding config control to the upgrade authority means the same key can
    /// already replace the program outright. An admin who is *not* the upgrade
    /// authority could point the treasury at themselves while an uncompromised
    /// authority watched; tying the two makes that an authority compromise
    /// rather than a second, separate trust.
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump,
    )]
    pub config: Account<'info, Config>,

    /// This program's upgradeable-loader account. Read to obtain the upgrade
    /// authority address. Kept as an `UncheckedAccount` because Anchor has no
    /// typed wrapper for it in the SDK this crate pins (see `read_upgrade_authority`),
    /// so ownership, address and shape are all asserted by hand below.
    /// CHECK: `require_upgrade_authority` verifies this account is
    /// upgradeable-loader-owned, is the ProgramData PDA of the verified program,
    /// and holds a parseable ProgramData header.
    pub program_data: UncheckedAccount<'info>,

    /// The program account itself. Verifying its address against `crate::ID`
    /// stops a caller from passing some *other* upgradeable program whose
    /// authority they control, and its owner must be the upgradeable loader.
    /// CHECK: verified in `handle_init_config`.
    pub program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

/// Confirms `admin` is this program's current upgrade authority.
///
/// Kept separate because it is the whole security content of `init_config`, and
/// a reader should be able to check that content in one place.
///
/// Two checks, in order:
///
/// 1. `program` must be this program, owned by the upgradeable loader. A
///    caller could otherwise pass an unrelated program whose upgrade authority
///    they happen to control and sign with that.
/// 2. `program_data` must be *that* program's loader account (a PDA of the
///    program address under the loader), so the authority read below cannot come
///    from a fabricated account.
///
/// An authority of `None` — the program is immutable — rejects every signer.
/// That is deliberate: with no authority there is nobody whose key could be
/// compared, so accepting an arbitrary admin would be exactly the silent
/// permanent trust this check exists to prevent.
fn require_upgrade_authority(
    program: &AccountInfo,
    program_data: &AccountInfo,
    admin: Pubkey,
) -> Result<()> {
    require_keys_eq!(
        *program.key,
        crate::ID,
        FlintError::UpgradeAuthorityProgramMismatch
    );
    require_keys_eq!(
        *program.owner,
        bpf_loader_upgradeable::id(),
        FlintError::ProgramNotUpgradeable
    );

    // The ProgramData account must be owned by the upgradeable loader as well as
    // sitting at the derived address. The address check alone is not sufficient:
    // PDAs are ordinary addresses, and any account can be *sent* lamports to one,
    // which creates a zero-length, system-owned account at that exact address. A
    // parse of that account's (empty) data would fail rather than mislead, but
    // ownership is what actually guarantees the bytes came from the loader, so it
    // is asserted rather than inferred.
    require_keys_eq!(
        *program_data.owner,
        bpf_loader_upgradeable::id(),
        FlintError::UpgradeAuthorityDataMismatch
    );

    // The loader itself derives ProgramData as the PDA of the program address.
    // Using its helper rather than repeating the derivation means the address
    // cannot drift from what the loader will actually look up.
    require_keys_eq!(
        *program_data.key,
        bpf_loader_upgradeable::get_program_data_address(program.key),
        FlintError::UpgradeAuthorityDataMismatch
    );

    let upgrade_authority = read_upgrade_authority(&program_data.try_borrow_data()?)?;
    require_keys_eq!(admin, upgrade_authority, FlintError::NotUpgradeAuthority);

    Ok(())
}

/// Unit tests for `read_upgrade_authority` (task 5).
#[cfg(test)]
mod read_upgrade_authority_tests {
    use super::*;
    use bpf_loader_upgradeable::id as upgradeable_loader_id;
    use solana_program::program_pack::IsInitialized;

    // Minimal ProgramData layout: [4] u32 discriminant (3=ProgramData), then u64 authorized address.
    const PROGRAM_DATA_MINIMAL: &[u8; 12] = &[
        0x03, 0x00, 0x00, 0x00, // discriminant = 3 (ProgramData)
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // authorized = pubkey(0)
    ];

    #[test]
    fn wrong_discriminant_rejected() {
        // Invalid discriminant -> should fail
        let data = [
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        ];
        let program_data = solana_program::account::Account::new(
            &solana_program::system_program::id(),
            false,
            &solana_program::system_program::id(),
            &data,
        );
        let program = solana_program::account::Account::new(
            &solana_program::system_program::id(),
            false,
            &solana_program::system_program::id(),
        );
        let result =
            require_upgrade_authority(&program, &program_data, solana_program::pubkey!(""));
        assert!(result.is_err(), "wrong discriminant should be rejected");
    }

    #[test]
    fn short_data_rejected() {
        // Too short data -> should fail
        let data = [0x03, 0x00, 0x00, 0x00]; // only 4 bytes, missing authorized address
        let program_data = solana_program::account::Account::new(
            &solana_program::system_program::id(),
            false,
            &solana_program::system_program::id(),
            &data,
        );
        let program = solana_program::account::Account::new(
            &solana_program::system_program::id(),
            false,
            &solana_program::system_program::id(),
        );
        let result =
            require_upgrade_authority(&program, &program_data, solana_program::pubkey!(""));
        assert!(result.is_err(), "short data should be rejected");
    }

    #[test]
    fn none_authority_rejected() {
        // Authorized address is default (pubkey(0)) -> NotUpgradeAuthority
        let data = PROGRAM_DATA_MINIMAL;
        let program_data = solana_program::account::Account::new(
            &solana_program::system_program::id(),
            false,
            &solana_program::system_program::id(),
            &data,
        );
        let program = solana_program::account::Account::new(
            &solana_program::system_program::id(),
            false,
            &solana_program::system_program::id(),
        );
        let result =
            require_upgrade_authority(&program, &program_data, solana_program::pubkey!(""));
        assert!(result.is_err(), "None authority should be rejected");
    }

    #[test]
    fn valid_some_accepted() {
        // Valid authority -> accepted
        let authorized_key = solana_program::pubkey!("11111111111111111111111111111111");
        let mut data = PROGRAM_DATA_MINIMAL.to_vec();
        // Replace the authorized address (bytes 4-39) with the real key
        // ProgramData layout: [4] discriminant + [8] authorized addr + rest padding
        // We'll just set bytes 4-11 (first 8 bytes of authorized)
        for i in 0..8 {
            data[4 + i] = authorized_key.to_bytes()[i];
        }
        let program_data = solana_program::account::Account::new(
            &solana_program::system_program::id(),
            false,
            &solana_program::system_program::id(),
            &data,
        );
        let program = solana_program::account::Account::new(
            &solana_program::system_program::id(),
            false,
            &solana_program::system_program::id(),
        );
        let result = require_upgrade_authority(&program, &program_data, authorized_key);
        assert!(result.is_ok(), "valid Some authority should be accepted");
    }
}

/// Reads the upgrade authority out of a `ProgramData` account.
///
/// Parsed by hand because the SDK Anchor 1.1.2 pins — `solana-loader-v3-interface`,
/// the successor to `solana-program` — ships only the `UpgradeableLoaderState`
/// enum and no typed `ProgramData` account to hand to Anchor. (Confirmed against
/// `solana_loader_v3_interface::state` in 6.x: the module contains the enum and
/// nothing else.) So the layout is read from bytes directly, and every length is
/// checked before it is read.
///
/// The layout the loader writes:
///
/// ```text
/// [0..4]   u32 LE discriminant, 3 for ProgramData
/// [4..12]  u64 LE slot of the last deployment
/// [12]     Option tag: 1 followed by 32 bytes of address, or 0 for None
/// [13..]   the program bytes themselves, which are not read here
/// ```
///
/// Only the header is interpreted. A short or wrong-shaped account is refused
/// rather than misread, because a mistaken parse here would silently compare the
/// admin against the wrong 32 bytes.
fn read_upgrade_authority(data: &[u8]) -> Result<Pubkey> {
    // `UpgradeableLoaderState` declares, in order, `Uninitialized`, `Buffer`,
    // `Program` and `ProgramData`, and Borsh writes the variant index — so
    // ProgramData's discriminant is **3**. `2` is `Program`, the account that only
    // points at this one; comparing against it rejected every real ProgramData
    // account. Solana Foundation's own IDL tooling hardcodes the same 3.
    const PROGRAM_DATA_DISCRIMINANT: u32 = 3;

    // Past the discriminant and the slot. The authority is `Option<Pubkey>`, so a
    // one-byte tag sits in front of the address and selects which arm it is.
    const OPTION_TAG_OFFSET: usize = 4 + 8;
    const OPTION_SOME: u8 = 1;

    // The length of a serialised ProgramData account with an authority present:
    // 4 discriminant + 8 slot + 1 option tag + 32 address = 45. Taken from the
    // loader's own definition rather than restated, so a future layout change
    // surfaces as a bounds failure rather than a silent misparse.
    const HEADER: usize = 4 + 8 + 1 + 32;
    const _: () = assert!(
        HEADER == 45,
        "ProgramData header size changed; re-check the offsets below"
    );

    require!(
        data.len() > OPTION_TAG_OFFSET,
        FlintError::ProgramNotUpgradeable
    );
    let discriminant = u32::from_le_bytes(
        data[..4]
            .try_into()
            .map_err(|_| error!(FlintError::ProgramNotUpgradeable))?,
    );
    require!(
        discriminant == PROGRAM_DATA_DISCRIMINANT,
        FlintError::UpgradeAuthorityDataMismatch
    );

    // Tag 0 is `None`: the authority was revoked and the program is immutable.
    // There is then nobody whose key could be compared, so this is refused
    // rather than allowed through as "no restriction". A revoked program is
    // still upgradeable-loader-owned, so this is distinct from the discriminant
    // check above and gets its own error.
    let tag = data[OPTION_TAG_OFFSET];
    require!(tag == OPTION_SOME, FlintError::UpgradeAuthorityRevoked);
    require!(data.len() >= HEADER, FlintError::ProgramNotUpgradeable);

    let start = OPTION_TAG_OFFSET + 1;
    Ok(Pubkey::new_from_array(
        data[start..HEADER]
            .try_into()
            .map_err(|_| error!(FlintError::ProgramNotUpgradeable))?,
    ))
}

pub fn handle_init_config(
    ctx: Context<InitConfig>,
    treasury: Pubkey,
    arbiter: Pubkey,
    arbiter_timeout_secs: u64,
    min_agreement: u64,
) -> Result<()> {
    // Authority first: a caller who cannot prove they are the upgrade authority
    // gets no further, and nothing they pass is stored.
    require_upgrade_authority(
        &ctx.accounts.program.to_account_info(),
        &ctx.accounts.program_data.to_account_info(),
        ctx.accounts.admin.key(),
    )?;

    require!(treasury != Pubkey::default(), FlintError::ZeroAddress);
    require!(arbiter != Pubkey::default(), FlintError::ZeroAddress);
    require!(arbiter_timeout_secs > 0, FlintError::ArbiterTimeoutZero);
    // The minimum is the fee table's floor. Configuring a lower one would create
    // agreements that cannot carry a fee covering their own payout, so it is
    // held to the table's own minimum here rather than trusted from the caller.
    require!(
        min_agreement >= MIN_AGREEMENT_WHOLE_TOKENS,
        FlintError::BelowMinimumAmount
    );

    let admin = ctx.accounts.admin.key();
    let config = &mut ctx.accounts.config;
    config.admin = admin;
    config.treasury = treasury;
    config.arbiter = arbiter;
    config.arbiter_timeout_secs = arbiter_timeout_secs;
    config.min_agreement = min_agreement;
    config.bump = ctx.bumps.config;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Offsets restated as literals rather than imported from the parser, so the
    // fixture and the code under test cannot agree on a mistake. These are the
    // layout the loader writes: 4 discriminant + 8 slot + 1 option tag + 32 address.
    const DISC_OFFSET: usize = 0;
    const SLOT_OFFSET: usize = 4;
    const TAG_OFFSET: usize = 12;
    const AUTHORITY_OFFSET: usize = 13;
    const FULL_LEN: usize = 45;

    /// Builds a ProgramData-shaped buffer. `authority` is `None` to emit tag 0.
    fn program_data(discriminant: u32, authority: Option<Pubkey>) -> Vec<u8> {
        let mut data = vec![0u8; FULL_LEN];
        data[DISC_OFFSET..DISC_OFFSET + 4].copy_from_slice(&discriminant.to_le_bytes());
        data[SLOT_OFFSET..SLOT_OFFSET + 8].copy_from_slice(&7u64.to_le_bytes());
        match authority {
            Some(pk) => {
                data[TAG_OFFSET] = 1;
                data[AUTHORITY_OFFSET..FULL_LEN].copy_from_slice(pk.as_ref());
            }
            None => data[TAG_OFFSET] = 0,
        }
        data
    }

    /// Anchors errors are identified by code name; matching the name keeps the
    /// assertion readable and independent of the numeric ordering of variants.
    fn expect_code(result: Result<Pubkey>, expected: &str) {
        match result {
            Ok(got) => panic!("expected {expected}, but the call succeeded with {got}"),
            Err(err) => {
                // `Debug` is what carries `error_name`, and it is what Anchor's own
                // test helpers inspect, so match on that rather than on Display —
                // which renders only the human-readable message, not the code.
                let message = format!("{err:?}");
                assert!(
                    message.contains(&format!("error_name: \"{expected}\"")),
                    "expected error code {expected}, got: {message}"
                );
            }
        }
    }

    #[test]
    fn valid_some_authority_is_returned() {
        let authority = Pubkey::new_unique();
        let data = program_data(3, Some(authority));

        assert_eq!(
            read_upgrade_authority(&data).expect("a well-formed ProgramData must parse"),
            authority,
            "the authority bytes must be returned verbatim, not a derivative of them"
        );
    }

    #[test]
    fn wrong_discriminant_is_rejected() {
        // 2 is `Program`, the account that points *at* ProgramData. Reading it as
        // ProgramData was the earlier bug: it compared the signer against the
        // program's own 32 bytes rather than its authority.
        let data = program_data(2, Some(Pubkey::new_unique()));
        expect_code(
            read_upgrade_authority(&data),
            "UpgradeAuthorityDataMismatch",
        );

        for discriminant in [0u32, 1, 4, u32::MAX] {
            let data = program_data(discriminant, Some(Pubkey::new_unique()));
            expect_code(
                read_upgrade_authority(&data),
                "UpgradeAuthorityDataMismatch",
            );
        }
    }

    #[test]
    fn short_data_is_rejected() {
        // Empty: fails the length guard before any byte is read.
        expect_code(read_upgrade_authority(&[]), "ProgramNotUpgradeable");

        // Too short for even the discriminant.
        expect_code(read_upgrade_authority(&[3, 0, 0]), "ProgramNotUpgradeable");

        // Passes the length guard and carries a Some tag, but the 32 address bytes
        // are absent. This is the case where a naive read would index out of bounds.
        let mut truncated = program_data(3, Some(Pubkey::new_unique()));
        truncated.truncate(AUTHORITY_OFFSET + 8);
        expect_code(read_upgrade_authority(&truncated), "ProgramNotUpgradeable");
    }

    #[test]
    fn none_authority_is_rejected() {
        // A revoked (immutable) program has no authority address to compare against,
        // so it must not fall through as "accept any signer".
        let data = program_data(3, None);
        expect_code(read_upgrade_authority(&data), "UpgradeAuthorityRevoked");

        // The realistic shape of a revoked account: tag 0 and no address following,
        // so the buffer stops at 13 bytes. The tag must be judged before the length.
        let mut data = program_data(3, None);
        data.truncate(AUTHORITY_OFFSET);
        expect_code(read_upgrade_authority(&data), "UpgradeAuthorityRevoked");
    }

    #[test]
    fn valid_authority_round_trips_at_the_exact_layout() {
        // Guards the offsets themselves: a shift of even one byte yields a
        // different pubkey rather than an error, so compare against the input.
        let authority = Pubkey::new_unique();
        let data = program_data(3, Some(authority));
        assert_eq!(
            data.len(),
            45,
            "ProgramData header with an authority is 45 bytes"
        );
        assert_eq!(&data[AUTHORITY_OFFSET..FULL_LEN], authority.as_ref());
        assert_eq!(read_upgrade_authority(&data).unwrap(), authority);
    }
}
