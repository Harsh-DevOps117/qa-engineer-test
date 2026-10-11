import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { findUserByEmail, createUser } from '../db/database.js';
import { validateEmail, normalizeEmail } from '../utils/validation.js';

const router = express.Router();
const JWT_SECRET = 'test-secret-key-do-not-use-in-production';

// POST /api/auth/register
router.post('/register', async (req, res) => {
  try {
    const { password, business_name } = req.body;

    // Validation
    // BUG C fix: validateEmail now requires a domain with a TLD and a string
    // input (the old regex had no TLD requirement and accepted "user@domain")
    if (!validateEmail(req.body.email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }
    const email = normalizeEmail(req.body.email);

    // typeof checks: a numeric password used to reach bcrypt and cause a 500
    if (typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    if (typeof business_name !== 'string' || business_name.trim().length < 2) {
      return res.status(400).json({ error: 'Business name is required' });
    }

    // Check if user exists
    const existingUser = findUserByEmail(email);
    if (existingUser) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create user
    const newUser = createUser({
      email,
      password: hashedPassword,
      business_name,
      type: 'merchant'
    });

    // Generate token
    const token = jwt.sign(
      { id: newUser.id, email: newUser.email, type: 'merchant' },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.status(201).json({
      message: 'Registration successful',
      user: {
        id: newUser.id,
        email: newUser.email,
        business_name: newUser.business_name
      },
      token
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    // Find user (emails are stored normalised at registration)
    const user = findUserByEmail(normalizeEmail(email));
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Check password
    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Generate token
    const token = jwt.sign(
      { id: user.id, email: user.email, type: user.type },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      message: 'Login successful',
      user: {
        id: user.id,
        email: user.email,
        business_name: user.business_name
      },
      token
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

export default router;
