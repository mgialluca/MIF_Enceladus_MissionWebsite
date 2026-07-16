// Login logic: validates credentials against USERS and routes users to their group/admin page
// Handles login form submission: checks input against USERS,
// stores session info in sessionStorage, and redirects appropriately.

document.getElementById("login-form").addEventListener("submit", function (e) {
  e.preventDefault();

  const enteredName = document.getElementById("username").value.trim().toUpperCase();
  const enteredPasscode = document.getElementById("passcode").value.trim();
  const errorMessage = document.getElementById("error-message");

  const user = USERS[enteredName];

  if (!user || user.passcode !== enteredPasscode) {
    errorMessage.textContent = "Login name or passcode not recognized. Please try again.";
    return;
  }

  // Store session info so other pages can check who's logged in.
  // sessionStorage clears when the browser tab closes — appropriate for a workshop.
  sessionStorage.setItem("currentUser", JSON.stringify({
    login: enteredName,
    role: user.role,
    group: user.group,
    displayName: user.displayName
  }));

  // Redirect based on role
  if (user.role === "admin") {
    window.location.href = "pages/admin.html";
  } else if (user.group === "HIVE") {
    window.location.href = "pages/HIVE/dashboard.html";
  } else if (user.group === "WhiteWhale") {
    window.location.href = "pages/WhiteWhale/dashboard.html";
  }
});