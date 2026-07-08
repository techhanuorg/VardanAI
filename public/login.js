document.addEventListener('DOMContentLoaded', () => {
  const loginForm = document.getElementById('login-form');
  const passwordInput = document.getElementById('password');
  const togglePasswordBtn = document.getElementById('toggle-password');
  const errorMsg = document.getElementById('error-msg');
  const btnSubmit = document.getElementById('btn-submit');

  // Toggle password visibility
  togglePasswordBtn.addEventListener('click', () => {
    const isPassword = passwordInput.getAttribute('type') === 'password';
    passwordInput.setAttribute('type', isPassword ? 'text' : 'password');
    togglePasswordBtn.querySelector('i').className = isPassword ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye';
  });

  // Handle Form Submission
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorMsg.style.display = 'none';
    btnSubmit.classList.add('loading');

    const password = passwordInput.value;

    try {
      const response = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      });

      const data = await response.json();

      if (response.ok && data.success) {
        // Redirect to control panel
        window.location.href = '/dashboard.html';
      } else {
        btnSubmit.classList.remove('loading');
        errorMsg.style.display = 'flex';
        passwordInput.value = '';
        passwordInput.focus();
      }
    } catch (error) {
      console.error('Login error:', error);
      btnSubmit.classList.remove('loading');
      alert('Network error during authentication. Please check if the server is running.');
    }
  });
});
