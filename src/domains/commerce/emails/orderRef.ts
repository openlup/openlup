// The customer-facing order reference now lives in a domain-neutral module so the
// thank-you page, account, and payment screens share the exact string the emails
// use. Re-exported here to keep the email templates' `./orderRef` imports stable.
export { formatCustomerOrderReference } from "../../../lib/orderRef.js";
