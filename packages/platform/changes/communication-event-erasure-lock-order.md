- Fix concurrent ecommerce-event projection and personal-data erasure by taking the receipts relation lock before subject row locks through a restricted preparation function. Recipient erasure, export, retained source facts and replay fences keep their existing behavior.

Migration: install the complete selected native chain through `20261119200000_communication_event_prepare_erasure.sql` before using the updated privacy contributor.
