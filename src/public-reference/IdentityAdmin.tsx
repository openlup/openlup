import { Navigate } from "react-router-dom";
import { useAuth } from "@/lib/authContext";
import { IdentityPrivacyPanel } from "@/pages/admin/IdentityPrivacyPanel";

export function IdentityAdmin() {
  const { loading, session, isAdmin, role, signOut } = useAuth();
  if (loading) return <p role="status">Checking operator access…</p>;
  if (!session) return <Navigate to="/admin/login" replace />;
  if (!isAdmin || (role !== "admin" && role !== "distributor")) return <p role="alert">Operator access denied</p>;
  return <main><h1>Identity administration</h1><p>Role: {role}</p>
    <button onClick={() => void signOut()}>Sign out</button>
    {role === "admin" && <IdentityPrivacyPanel accessToken={session.access_token} />}</main>;
}
