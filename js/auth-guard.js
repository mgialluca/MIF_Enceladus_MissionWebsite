// Include this on every protected page (dashboards, admin).
// Redirects to login if no valid session, or if role/group doesn't match.
function requireAuth(expectedRole, expectedGroup, loginPath) {
  const raw = sessionStorage.getItem("currentUser");
  if (!raw) {
    window.location.href = loginPath;
    return null;
  }
  const user = JSON.parse(raw);
  if (expectedRole && user.role !== expectedRole) {
    window.location.href = loginPath;
    return null;
  }
  if (expectedGroup && user.group !== expectedGroup) {
    window.location.href = loginPath;
    return null;
  }
  return user;
}