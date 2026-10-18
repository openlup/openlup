import { Navigate } from "react-router-dom";
import { useCustomerAuth } from "@/lib/customerAuthContext";

export function IdentityAccount() {
  const { loading, session, profile, signOut } = useCustomerAuth();
  if (loading) return <p role="status">Loading account…</p>;
  if (!session) return <Navigate to="/sign-in" replace />;
  if (!profile) return <p role="alert">Linked customer profile unavailable</p>;
  return <main><h1>Your identity account</h1><p>{profile.email}</p><p>Contact ID: <span data-testid="contact-id">{profile.clientId}</span></p>
    <button onClick={() => void signOut()}>Sign out</button></main>;
}
