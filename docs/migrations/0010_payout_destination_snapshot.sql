alter table payout_batches
  add column if not exists bank_name text,
  add column if not exists bik text,
  add column if not exists destination_account_ciphertext text,
  add column if not exists account_last_four char(4);

update payout_batches payout
set bank_name = bank.bank_name,
    bik = bank.bik,
    destination_account_ciphertext = bank.settlement_account_ciphertext,
    account_last_four = bank.account_last_four
from venue_bank_accounts bank
where bank.venue_id = payout.venue_id
  and payout.destination_account_ciphertext is null;
