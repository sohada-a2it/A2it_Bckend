require("dotenv").config();
const express = require("express");
const cors = require("cors");
const nodemailer = require("nodemailer");
const rateLimit = require("express-rate-limit"); // npm install express-rate-limit
const fs = require("fs");
const path = require("path");

const app = express();

// ============ রেট লিমিট কনফিগারেশন ============
// প্রতি মিনিটে সর্বোচ্চ ৫টি ইমেল (Hostinger-এর ১০ এর নিচে)
const emailLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 মিনিট
  max: 5, // সর্বোচ্চ ৫টি রিকোয়েস্ট প্রতি মিনিটে
  message: { 
    error: "Too many requests. Please try again after 1 minute.",
    limit: "5 requests per minute allowed"
  },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false, // সফল রিকোয়েস্টও গণনা হবে
});

// IP ভিত্তিক রেট লিমিট (যদি একই IP থেকে অনেক রিকোয়েস্ট আসে)
const ipLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 মিনিট
  max: 20, // প্রতি IP থেকে সর্বোচ্চ ২০টি রিকোয়েস্ট
  message: { error: "Too many requests from this IP. Please try again later." }
});

// ============ Middleware ============
app.use(cors({
  origin: ['http://localhost:3000', 'https://yourfrontenddomain.com'],
  methods: ['POST', 'GET'],
  credentials: true
}));
app.use(express.json());

// Logger middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path} - IP: ${req.ip}`);
  next();
});

// ============ ইমেল লগ ফাংশন ============
function logEmail(data) {
  const logDir = path.join(__dirname, 'logs');
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir);
  }
  
  const logFile = path.join(logDir, 'email.log');
  const logEntry = `${new Date().toISOString()} | To: ${data.to} | Subject: ${data.subject} | Type: ${data.type || 'general'}\n`;
  
  fs.appendFile(logFile, logEntry, (err) => {
    if (err) console.error("Log write error:", err);
  });
}

// ============ ইমেল ট্রান্সপোর্টার (SMTP পুলিং সহ) ============
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.hostinger.com",
  port: parseInt(process.env.SMTP_PORT) || 465,
  secure: true,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASSWORD,
  },
  pool: true, // কানেকশন পুলিং সক্রিয়
  maxConnections: 1, // সর্বোচ্চ ১টি কানেকশন
  maxMessages: 5, // প্রতি কানেকশনে সর্বোচ্চ ৫টি মেইল
  rateDelta: 20000, // ২০ সেকেন্ড
  rateLimit: 3, // প্রতি ২০ সেকেন্ডে ৩টি মেইল
  maxConnections: 1,
maxMessages: Infinity,
  tls: {
    rejectUnauthorized: true, // ডেভেলপমেন্টের জন্য
  },
  // কানেকশন টাইমআউট
  connectionTimeout: 30000, // ৩০ সেকেন্ড
  greetingTimeout: 30000,
  socketTimeout: 60000,
});

// ট্রান্সপোর্টার ভেরিফাই
transporter.verify((error, success) => {
  if (error) {
    console.error("❌ SMTP connection error:", error);
  } else {
    console.log("✅ SMTP server is ready to send emails");
    console.log(`📊 Rate limit: 3 emails per 20 seconds`);
  }
});

// ============ ইমেল সেন্ড ফাংশন (রিট্রাই মেকানিজম সহ) ============
async function sendEmailWithRetry(mailOptions, maxRetries = 3) {
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`📧 Sending email (attempt ${attempt}/${maxRetries})...`);
      const info = await transporter.sendMail(mailOptions);
      console.log(`✅ Email sent successfully! Message ID: ${info.messageId}`);
      
      // লগ সংরক্ষণ
      logEmail({
        to: mailOptions.to,
        subject: mailOptions.subject,
        type: mailOptions.type || 'general'
      });
      
      return info;
    } catch (error) {
      lastError = error;
      console.error(`❌ Attempt ${attempt} failed:`, error.message);
      
      if (attempt < maxRetries) {
        // এক্সপোনেনশিয়াল ব্যাকঅফ
        const waitTime = Math.pow(2, attempt) * 1000;
        console.log(`⏳ Waiting ${waitTime/1000} seconds before retry...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
  }
  
  throw lastError;
}

// ============ ইমেল এন্ডপয়েন্ট ============
app.post("/api/send-email", emailLimiter, ipLimiter, async (req, res) => {
  const {
    name,
    email,
    phone,
    message,
    type,
    subject,
    model,
    shippingTerm,
  } = req.body;

  // Log received data
  console.log("📨 Received inquiry:", {
    type,
    name,
    email,
    phone,
    model,
    shippingTerm
  });

  // Validate required fields
  if (!name || !email || !phone) {
    return res.status(400).json({ 
      error: "Missing required fields",
      required: ["name", "email", "phone"] 
    });
  }

  // Email validation
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: "Invalid email format" });
  }

  // Phone validation (minimum 10 digits)
  const phoneDigits = phone.replace(/\D/g, '');
  if (phoneDigits.length < 10) {
    return res.status(400).json({ error: "Phone number must have at least 10 digits" });
  }

  try {
    let emailSubject, textContent, htmlContent;

    // ============ PRODUCT INQUIRY ============
    if (type && type.toLowerCase() === "product_inquiry") {
      const planModel = model || 'Not specified';
      const planDetails = shippingTerm || 'Not specified';
      
      emailSubject = subject || `🔔 New Consultation: ${planModel} Interested`;

      textContent = `
🔔 NEW CONSULTATION INQUIRY
================================
Selected Plan: ${planModel}
Plan Details: ${planDetails}

CUSTOMER DETAILS:
----------------
Name: ${name}
Email: ${email}
Phone: ${phone}

PROJECT DESCRIPTION:
-------------------
${message || 'No project description provided'}

================================
      `;

      htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>New Consultation Inquiry</title>
</head>
<body style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; margin: 0; padding: 0; background-color: #f7f7f7;">
  <div style="max-width: 600px; margin: 20px auto; background: white; border-radius: 16px; overflow: hidden; box-shadow: 0 8px 20px rgba(0,0,0,0.1);">
    
    <!-- Header with gradient and pattern -->
    <div style="background: linear-gradient(135deg, #7e602c 0%, #f5b342 100%); padding: 40px 30px; text-align: center; position: relative;">
      <div style="position: absolute; top: 0; left: 0; right: 0; bottom: 0; background-image: radial-gradient(circle at 30px 30px, rgba(255,255,255,0.1) 2px, transparent 2px); background-size: 30px 30px;"></div>
      
      <div style="position: relative; z-index: 1;">
        <div style="display: inline-block; background: rgba(255,255,255,0.2); backdrop-filter: blur(5px); color: white; font-size: 14px; font-weight: bold; padding: 8px 20px; border-radius: 50px; margin-bottom: 20px; border: 1px solid rgba(255,255,255,0.3);">
          🚀 NEW CONSULTATION REQUEST
        </div>
        <h1 style="color: white; margin: 0; font-size: 32px; font-weight: 800; letter-spacing: -0.5px; text-shadow: 0 2px 4px rgba(0,0,0,0.1);">
          ${name} wants to<br>activate 70% OFF!
        </h1>
      </div>
    </div>

    <!-- Content -->
    <div style="padding: 40px 30px;">
      
      <!-- Plan Details Card -->
      <div style="background: linear-gradient(135deg, #f8f9fa 0%, #ffffff 100%); border: 1px solid #e0e0e0; border-radius: 16px; padding: 25px; margin-bottom: 30px; box-shadow: 0 4px 10px rgba(0,0,0,0.02);">
        <h3 style="margin: 0 0 20px 0; color: #333; font-size: 18px; display: flex; align-items: center; gap: 10px;">
          <span style="background: #f5b342; color: white; width: 32px; height: 32px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center;">🎯</span>
          Selected Plan Details
        </h3>
        
        <div style="background: white; border-radius: 12px; padding: 20px; border: 1px solid #eaeaea;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; padding-bottom: 15px; border-bottom: 2px dashed #f0f0f0;">
            <span style="font-size: 14px; color: #666;">Plan Name</span>
            <span style="font-size: 18px; font-weight: 800; color: #f5b342;">${planModel}</span>
          </div>
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-size: 14px; color: #666;">Full Details</span>
            <span style="font-size: 14px; color: #333; text-align: right; max-width: 60%;">${planDetails}</span>
          </div>
        </div>
      </div>

      <!-- Customer Information Card -->
      <div style="background: #f8f9fa; border-radius: 16px; padding: 25px; margin-bottom: 30px; border: 1px solid #eaeaea;">
        <h3 style="margin: 0 0 20px 0; color: #333; font-size: 18px; display: flex; align-items: center; gap: 10px;">
          <span style="background: #7e602c; color: white; width: 32px; height: 32px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center;">👤</span>
          Customer Information
        </h3>
        
        <table style="width: 100%; border-collapse: collapse;">
          <tr>
            <td style="padding: 12px; border-bottom: 1px solid #eaeaea; color: #666; width: 35%; font-weight: 500;">Full Name:</td>
            <td style="padding: 12px; border-bottom: 1px solid #eaeaea; color: #333; font-weight: 600;">${name}</td>
          </tr>
          <tr>
            <td style="padding: 12px; border-bottom: 1px solid #eaeaea; color: #666; font-weight: 500;">Email:</td>
            <td style="padding: 12px; border-bottom: 1px solid #eaeaea;">
              <a href="mailto:${email}" style="color: #f5b342; text-decoration: none; font-weight: 600;">${email}</a>
            </td>
          </tr>
          <tr>
            <td style="padding: 12px; color: #666; font-weight: 500;">Phone:</td>
            <td style="padding: 12px;">
              <a href="tel:${phone}" style="color: #f5b342; text-decoration: none; font-weight: 600;">${phone}</a>
            </td>
          </tr>
        </table>
      </div>

      <!-- Project Description Card -->
      <div style="background: #f8f9fa; border-radius: 16px; padding: 25px; margin-bottom: 30px; border: 1px solid #eaeaea;">
        <h3 style="margin: 0 0 20px 0; color: #333; font-size: 18px; display: flex; align-items: center; gap: 10px;">
          <span style="background: #f5b342; color: white; width: 32px; height: 32px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center;">📝</span>
          Project Description
        </h3>
        <div style="background: white; border-radius: 12px; padding: 20px; line-height: 1.8; color: #333; font-size: 15px;">
          ${message || 'No project description provided'}
        </div>
      </div>

      <!-- Action Buttons -->
      <div style="text-align: center; margin: 40px 0 20px;">
        <a href="mailto:${email}" style="display: inline-block; background: #f5b342; color: white; text-decoration: none; padding: 15px 35px; border-radius: 50px; margin: 0 10px 10px 0; font-weight: 600; font-size: 15px; box-shadow: 0 4px 10px rgba(245, 179, 66, 0.3);">
          📧 Reply via Email
        </a>
        <a href="tel:${phone}" style="display: inline-block; background: #7e602c; color: white; text-decoration: none; padding: 15px 35px; border-radius: 50px; margin: 0 10px 10px 0; font-weight: 600; font-size: 15px; box-shadow: 0 4px 10px rgba(126, 96, 44, 0.3);">
          📞 Call Customer
        </a>
      </div>

      <!-- Footer -->
      <div style="margin-top: 40px; padding-top: 20px; text-align: center; border-top: 2px solid #eaeaea; color: #999; font-size: 13px;">
        <p style="margin: 5px 0;">This inquiry was sent from the consultation modal on your website.</p>
        <p style="margin: 5px 0;">Received: ${new Date().toLocaleString()}</p>
        <p style="margin: 15px 0 0 0;">© ${new Date().getFullYear()} A2ITLD. All rights reserved.</p>
      </div>
    </div>
  </div>
</body>
</html>
      `;
    } 
    
    // ============ BANNER INQUIRY ============
    else if (type && type.toLowerCase() === "banner_inquiry") {
      const selectedPackage = model || 'Not specified';
      const packageDetails = shippingTerm || 'Not specified';
      const projectDesc = message || 'No project description provided';
      
      emailSubject = subject || `🎯 NEW BANNER INQUIRY: ${selectedPackage} - 50% OFF ELIGIBLE`;

      textContent = `
🔔 NEW BANNER INQUIRY - 50% OFF ELIGIBLE
==========================================
Source: Hero Section Banner Form
Time: ${new Date().toLocaleString()}

SELECTED PACKAGE:
----------------
Package: ${selectedPackage}
Package Details: ${packageDetails}

CUSTOMER DETAILS:
----------------
Name: ${name}
Email: ${email}
Phone: ${phone}

PROJECT DESCRIPTION:
-------------------
${projectDesc}

==========================================
This customer is eligible for 50% discount on website package!
      `;

      htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>New Banner Inquiry</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap');
  </style>
</head>
<body style="font-family: 'Inter', Arial, sans-serif; margin: 0; padding: 0; background-color: #0a192f;">
  <div style="max-width: 600px; margin: 20px auto; background: white; border-radius: 24px; overflow: hidden; box-shadow: 0 20px 40px rgba(0,0,0,0.3);">
    
    <!-- Header with gradient -->
    <div style="background: linear-gradient(135deg, #0a192f 0%, #1a2f4f 100%); padding: 40px 30px; text-align: center; position: relative;">
      <div style="position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: url('data:image/svg+xml,<svg width="60" height="60" viewBox="0 0 60 60" xmlns="http://www.w3.org/2000/svg"><path d="M30 5 L55 20 L55 40 L30 55 L5 40 L5 20 L30 5" fill="none" stroke="rgba(245,179,66,0.1)" stroke-width="1"/></svg>') repeat; opacity: 0.2;"></div>
      
      <div style="position: relative; z-index: 1;">
        <!-- 50% OFF Badge -->
        <div style="display: inline-block; background: #f5b342; color: #0a192f; font-size: 14px; font-weight: 800; padding: 8px 24px; border-radius: 50px; margin-bottom: 20px; transform: rotate(-2deg); box-shadow: 0 4px 10px rgba(245,179,66,0.3);">
          ⚡ 50% OFF ELIGIBLE ⚡
        </div>
        
        <h1 style="color: white; margin: 10px 0; font-size: 36px; font-weight: 800; letter-spacing: -1px;">
          New Banner Inquiry!
        </h1>
        <p style="color: #f5b342; margin: 0; font-size: 18px; font-weight: 600;">
          ${selectedPackage}
        </p>
      </div>
    </div>

    <!-- Content -->
    <div style="padding: 40px 30px;">
      
      <!-- Package Card -->
      <div style="background: linear-gradient(135deg, #fff8e7 0%, #ffffff 100%); border: 2px solid #f5b342; border-radius: 20px; padding: 25px; margin-bottom: 30px; box-shadow: 0 10px 25px rgba(245,179,66,0.1);">
        <h3 style="margin: 0 0 20px 0; color: #0a192f; font-size: 20px; display: flex; align-items: center; gap: 10px;">
          <span style="background: #f5b342; color: #0a192f; width: 40px; height: 40px; border-radius: 12px; display: flex; align-items: center; justify-content: center; font-size: 20px;">🎯</span>
          Selected Package
        </h3>
        
        <div style="background: white; border-radius: 12px; padding: 20px; border: 1px solid #eaeaea;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; padding-bottom: 15px; border-bottom: 2px dashed #f0f0f0;">
            <span style="font-size: 14px; color: #666;">Package Name</span>
            <span style="font-size: 18px; font-weight: 800; color: #f5b342;">${selectedPackage}</span>
          </div>
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-size: 14px; color: #666;">Details</span>
            <span style="font-size: 14px; color: #333; text-align: right; max-width: 60%;">${packageDetails}</span>
          </div>
        </div>
      </div>

      <!-- Customer Details -->
      <div style="background: #f8f9fa; border-radius: 16px; padding: 25px; margin-bottom: 30px;">
        <h3 style="margin: 0 0 20px 0; color: #0a192f; font-size: 18px; display: flex; align-items: center; gap: 10px;">
          <span style="background: #0a192f; color: white; width: 32px; height: 32px; border-radius: 8px; display: flex; align-items: center; justify-content: center;">👤</span>
          Customer Information
        </h3>
        
        <div style="background: white; border-radius: 12px; padding: 20px;">
          <table style="width: 100%; border-collapse: collapse;">
            <tr>
              <td style="padding: 10px; border-bottom: 1px solid #eee; color: #666;">Name:</td>
              <td style="padding: 10px; border-bottom: 1px solid #eee; color: #0a192f; font-weight: 600;">${name}</td>
            </tr>
            <tr>
              <td style="padding: 10px; border-bottom: 1px solid #eee; color: #666;">Email:</td>
              <td style="padding: 10px; border-bottom: 1px solid #eee;">
                <a href="mailto:${email}" style="color: #f5b342; text-decoration: none; font-weight: 600;">${email}</a>
              </td>
            </tr>
            <tr>
              <td style="padding: 10px; color: #666;">Phone:</td>
              <td style="padding: 10px;">
                <a href="tel:${phone}" style="color: #f5b342; text-decoration: none; font-weight: 600;">${phone}</a>
              </td>
            </tr>
          </table>
        </div>
      </div>

      <!-- Project Description -->
      ${projectDesc !== 'No project description provided' ? `
      <div style="background: #f8f9fa; border-radius: 16px; padding: 25px; margin-bottom: 30px;">
        <h3 style="margin: 0 0 20px 0; color: #0a192f; font-size: 18px; display: flex; align-items: center; gap: 10px;">
          <span style="background: #f5b342; color: #0a192f; width: 32px; height: 32px; border-radius: 8px; display: flex; align-items: center; justify-content: center;">📝</span>
          Project Description
        </h3>
        <div style="background: white; border-radius: 12px; padding: 20px; line-height: 1.6; color: #333;">
          ${projectDesc}
        </div>
      </div>
      ` : ''}

      <!-- Quick Actions -->
      <div style="display: flex; gap: 15px; justify-content: center; margin: 30px 0;">
        <a href="mailto:${email}" style="background: #f5b342; color: #0a192f; text-decoration: none; padding: 15px 30px; border-radius: 12px; font-weight: 600; font-size: 14px; display: inline-flex; align-items: center; gap: 8px;">
          📧 Reply via Email
        </a>
        <a href="tel:${phone}" style="background: #0a192f; color: white; text-decoration: none; padding: 15px 30px; border-radius: 12px; font-weight: 600; font-size: 14px; display: inline-flex; align-items: center; gap: 8px;">
          📞 Call Now
        </a>
      </div>

      <!-- Footer -->
      <div style="margin-top: 30px; padding-top: 20px; text-align: center; border-top: 2px solid #eaeaea;">
        <div style="display: inline-block; background: #f5b342; color: #0a192f; font-size: 12px; font-weight: 600; padding: 5px 15px; border-radius: 50px; margin-bottom: 10px;">
          Hero Section Banner Form
        </div>
        <p style="color: #999; font-size: 12px; margin: 5px 0;">
          Received: ${new Date().toLocaleString()}
        </p>
      </div>
    </div>
  </div>
</body>
</html>
      `;
    } 
    
    // ============ FOOTER INQUIRY ============
    else if (type && type.toLowerCase() === "footer_inquiry") {
      emailSubject = subject || `📞 NEW FOOTER CONSULTATION: ${name} - Free Consultation Request`;

      textContent = `
📞 NEW FOOTER CONSULTATION REQUEST
==========================================
Source: Footer Contact Form
Time: ${new Date().toLocaleString()}

CONSULTATION DETAILS:
-------------------
Type: Free Website Consultation
Response Time: Within 2 hours

CUSTOMER DETAILS:
----------------
Name: ${name}
Email: ${email}
Phone: ${phone}

PROJECT DESCRIPTION:
-------------------
${message || 'No project description provided'}

==========================================
This customer requested a free consultation from the footer form.
      `;

      htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>New Footer Consultation Request</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap');
  </style>
</head>
<body style="font-family: 'Inter', Arial, sans-serif; margin: 0; padding: 0; background: linear-gradient(135deg, #0a192f 0%, #1a1f2f 100%);">
  <div style="max-width: 600px; margin: 20px auto; background: white; border-radius: 24px; overflow: hidden; box-shadow: 0 25px 50px rgba(0,0,0,0.3);">
    
    <!-- Header with gradient -->
    <div style="background: linear-gradient(135deg, #f97316 0%, #dc2626 100%); padding: 40px 30px; text-align: center; position: relative;">
      <div style="position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: url('data:image/svg+xml,<svg width="60" height="60" viewBox="0 0 60 60" xmlns="http://www.w3.org/2000/svg"><circle cx="30" cy="30" r="5" fill="rgba(255,255,255,0.1)"/></svg>') repeat; opacity: 0.2;"></div>
      
      <div style="position: relative; z-index: 1;">
        <!-- Free Consultation Badge -->
        <div style="display: inline-block; background: rgba(255,255,255,0.2); backdrop-filter: blur(5px); color: white; font-size: 14px; font-weight: 800; padding: 8px 24px; border-radius: 50px; margin-bottom: 20px; border: 1px solid rgba(255,255,255,0.3);">
          ⚡ FREE CONSULTATION REQUEST ⚡
        </div>
        
        <h1 style="color: white; margin: 10px 0; font-size: 36px; font-weight: 800; letter-spacing: -1px;">
          New Footer Inquiry!
        </h1>
        <p style="color: rgba(255,255,255,0.9); margin: 0; font-size: 18px;">
          ${name} wants to discuss a project
        </p>
      </div>
    </div>

    <!-- Content -->
    <div style="padding: 40px 30px;">
      
      <!-- Quick Response Badge -->
      <div style="background: linear-gradient(135deg, #f97316 0%, #dc2626 100%); border-radius: 16px; padding: 20px; margin-bottom: 30px; text-align: center;">
        <div style="display: inline-flex; align-items: center; gap: 10px; background: white; padding: 8px 20px; border-radius: 50px;">
          <span style="font-size: 16px;">⏰</span>
          <span style="color: #f97316; font-weight: 600; font-size: 14px;">Response within 2 hours</span>
        </div>
      </div>
      
      <!-- Customer Details Card -->
      <div style="background: #f8f9fa; border-radius: 20px; padding: 30px; margin-bottom: 30px; border: 1px solid #eaeaea;">
        <h3 style="margin: 0 0 25px 0; color: #0a192f; font-size: 20px; display: flex; align-items: center; gap: 10px;">
          <span style="background: #f97316; color: white; width: 40px; height: 40px; border-radius: 12px; display: flex; align-items: center; justify-content: center;">👤</span>
          Customer Information
        </h3>
        
        <div style="display: grid; gap: 15px;">
          <div style="background: white; border-radius: 12px; padding: 15px; border: 1px solid #eaeaea;">
            <div style="display: flex; align-items: center; gap: 10px;">
              <div style="width: 32px; height: 32px; background: #f97316; border-radius: 8px; display: flex; align-items: center; justify-content: center;">
                <span style="color: white; font-weight: 600;">👤</span>
              </div>
              <div>
                <div style="font-size: 12px; color: #666;">Full Name</div>
                <div style="font-size: 16px; font-weight: 600; color: #0a192f;">${name}</div>
              </div>
            </div>
          </div>
          
          <div style="background: white; border-radius: 12px; padding: 15px; border: 1px solid #eaeaea;">
            <div style="display: flex; align-items: center; gap: 10px;">
              <div style="width: 32px; height: 32px; background: #f97316; border-radius: 8px; display: flex; align-items: center; justify-content: center;">
                <span style="color: white; font-weight: 600;">📧</span>
              </div>
              <div>
                <div style="font-size: 12px; color: #666;">Email Address</div>
                <a href="mailto:${email}" style="font-size: 16px; font-weight: 600; color: #f97316; text-decoration: none;">${email}</a>
              </div>
            </div>
          </div>
          
          <div style="background: white; border-radius: 12px; padding: 15px; border: 1px solid #eaeaea;">
            <div style="display: flex; align-items: center; gap: 10px;">
              <div style="width: 32px; height: 32px; background: #f97316; border-radius: 8px; display: flex; align-items: center; justify-content: center;">
                <span style="color: white; font-weight: 600;">📞</span>
              </div>
              <div>
                <div style="font-size: 12px; color: #666;">Phone Number</div>
                <a href="tel:${phone}" style="font-size: 16px; font-weight: 600; color: #f97316; text-decoration: none;">${phone}</a>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Project Description -->
      <div style="background: #f8f9fa; border-radius: 20px; padding: 30px; margin-bottom: 30px; border: 1px solid #eaeaea;">
        <h3 style="margin: 0 0 20px 0; color: #0a192f; font-size: 18px; display: flex; align-items: center; gap: 10px;">
          <span style="background: #f97316; color: white; width: 32px; height: 32px; border-radius: 8px; display: flex; align-items: center; justify-content: center;">📝</span>
          Project Details
        </h3>
        <div style="background: white; border-radius: 12px; padding: 20px; line-height: 1.6; color: #333; font-size: 15px; border: 1px solid #eaeaea;">
          ${message || 'No project description provided'}
        </div>
      </div>

      <!-- Action Buttons -->
      <div style="display: flex; gap: 15px; justify-content: center; margin: 30px 0;">
        <a href="mailto:${email}" style="background: #f97316; color: white; text-decoration: none; padding: 15px 30px; border-radius: 12px; font-weight: 600; font-size: 14px; display: inline-flex; align-items: center; gap: 8px; box-shadow: 0 10px 20px rgba(249,115,22,0.3);">
          📧 Reply via Email
        </a>
        <a href="tel:${phone}" style="background: #0a192f; color: white; text-decoration: none; padding: 15px 30px; border-radius: 12px; font-weight: 600; font-size: 14px; display: inline-flex; align-items: center; gap: 8px; box-shadow: 0 10px 20px rgba(10,25,47,0.3);">
          📞 Call Now
        </a>
      </div>

      <!-- Footer -->
      <div style="margin-top: 30px; padding-top: 20px; text-align: center; border-top: 2px solid #eaeaea;">
        <div style="display: inline-block; background: #f97316; color: white; font-size: 12px; font-weight: 600; padding: 5px 15px; border-radius: 50px; margin-bottom: 10px;">
          Footer Consultation Form
        </div>
        <p style="color: #999; font-size: 12px; margin: 5px 0;">
          Received: ${new Date().toLocaleString()}
        </p>
        <p style="color: #999; font-size: 11px;">
          This customer requested a free consultation from the website footer.
        </p>
      </div>
    </div>
  </div>
</body>
</html>
      `;
    } 
    
    // ============ GENERAL INQUIRY ============
    else {
      emailSubject = subject || "New Inquiry from Website";
      
      textContent = `
NEW INQUIRY
================
Customer Details:
Name: ${name}
Email: ${email}
Phone: ${phone || "Not provided"}
----------------------------
Customer Message:
${message || "No message provided"}
================
      `;

      htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>New Website Inquiry</title>
</head>
<body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
  <div style="background: #f9f9f9; padding: 30px; border-radius: 10px;">
    <h2 style="color: #e67e22; border-bottom: 2px solid #e67e22; padding-bottom: 10px;">
      New Website Inquiry
    </h2>
    
    <div style="background: white; padding: 20px; border-radius: 8px; margin-top: 20px;">
      <h3 style="margin-top: 0; color: #555;">Customer Details:</h3>
      
      <table style="width: 100%; border-collapse: collapse;">
        <tr>
          <td style="padding: 10px; border-bottom: 1px solid #eee; width: 30%;"><strong>Name:</strong></td>
          <td style="padding: 10px; border-bottom: 1px solid #eee;">${name}</td>
        </tr>
        <tr>
          <td style="padding: 10px; border-bottom: 1px solid #eee;"><strong>Email:</strong></td>
          <td style="padding: 10px; border-bottom: 1px solid #eee;">
            <a href="mailto:${email}" style="color: #e67e22; text-decoration: none;">${email}</a>
          </td>
        </tr>
        <tr>
          <td style="padding: 10px; border-bottom: 1px solid #eee;"><strong>Phone:</strong></td>
          <td style="padding: 10px; border-bottom: 1px solid #eee;">
            <a href="tel:${phone}" style="color: #e67e22; text-decoration: none;">${phone || "Not provided"}</a>
          </td>
        </tr>
      </table>
      
      <div style="margin-top: 20px; background: #f5f5f5; padding: 15px; border-radius: 5px;">
        <h4 style="margin-top: 0; color: #e67e22;">Customer Message:</h4>
        <p style="white-space: pre-wrap; margin-bottom: 0; line-height: 1.6;">${message || "No message provided"}</p>
      </div>
      
      <div style="margin-top: 30px; padding-top: 20px; text-align: center; border-top: 1px solid #eee; color: #999; font-size: 12px;">
        <p>Received: ${new Date().toLocaleString()}</p>
        <p>© ${new Date().getFullYear()} Your Company. All rights reserved.</p>
      </div>
    </div>
  </div>
</body>
</html>
      `;
    }

    // মেইল অপশন তৈরি
    const mailOptions = {
      from: `"Website Inquiry" <${process.env.SMTP_USER}>`,
      to: process.env.OWNER_EMAIL,
      subject: emailSubject,
      text: textContent,
      html: htmlContent,
      type: type || 'general' // লগের জন্য
    };

    // ইমেল পাঠান (রিট্রাই মেকানিজম সহ)
    await sendEmailWithRetry(mailOptions);

    // সফল রেসপন্স
    res.status(200).json({ 
      success: true, 
      message: "Email sent successfully",
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error("❌ Fatal error sending email:", error);
    
    // নির্দিষ্ট error message
    if (error.code === 'EAUTH') {
      res.status(500).json({ error: "Email authentication failed. Please check SMTP credentials." });
    } else if (error.code === 'ESOCKET') {
      res.status(500).json({ error: "Network error. Please try again." });
    } else if (error.responseCode === 554) {
      res.status(500).json({ error: "Email rejected. Daily limit might be exceeded." });
    } else if (error.code === 'ETIMEDOUT') {
      res.status(500).json({ error: "Connection timeout. Please try again." });
    } else {
      res.status(500).json({ error: "Failed to send email. Please try again later." });
    }
  }
});

// ============ স্ট্যাটাস এন্ডপয়েন্ট ============
app.get("/api/email-status", (req, res) => {
  res.status(200).json({
    status: "active",
    smtp: {
      host: process.env.SMTP_HOST || "smtp.hostinger.com",
      port: parseInt(process.env.SMTP_PORT) || 465,
      secure: true
    },
    limits: {
      ratePerMinute: 5,
      maxRetries: 3,
      poolSize: 1,
      messagesPerConnection: 5
    },
    timestamp: new Date().toISOString()
  });
});

// ============ হেলথ চেক এন্ডপয়েন্ট ============
app.get("/api/health", (req, res) => {
  res.status(200).json({ 
    status: "OK", 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    endpoints: ["/api/send-email", "/api/email-status", "/api/health"]
  });
});

// ============ 404 হ্যান্ডলার ============
app.use((req, res) => {
  res.status(404).json({ error: "Endpoint not found" });
});

// ============ এরর হ্যান্ডলার ============
app.use((err, req, res, next) => {
  console.error("Server error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// ============ সার্ভার স্টার্ট ============
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log("=".repeat(50));
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📧 Email service: ${process.env.SMTP_USER}`);
  console.log(`📊 Rate limit: 5 emails per minute`);
  console.log(`🔗 Health check: http://localhost:${PORT}/api/health`);
  console.log("=".repeat(50));
});