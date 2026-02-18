require("dotenv").config();
const express = require("express");
const cors = require("cors");
const nodemailer = require("nodemailer");

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Nodemailer transporter (create once)
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.hostinger.com",
  port: parseInt(process.env.SMTP_PORT) || 587, // 587 is safer for STARTTLS
  secure: process.env.SMTP_PORT === "465", // true for 465, false for 587
  auth: {
    user: process.env.SMTP_USER || process.env.OWNER_EMAIL,
    pass: process.env.SMTP_PASSWORD,
  },
  tls: {
    rejectUnauthorized: false, // ignore self-signed certs
  },
});

// Verify connection at startup
transporter.verify((err, success) => {
  if (err) console.error("SMTP connection error:", err);
  else console.log("SMTP server ready to send emails");
});

// Email endpoint
app.post("/api/send-email", async (req, res) => {
  const {
    name,
    email,
    phone,
    company,
    message,
    address,
    quantity,
    model,
    type,
    subject,
    shippingTerm,
  } = req.body;

  try {
    let emailSubject = "";
    let textContent = "";
    let htmlContent = "";

    if (type === "product_inquiry") {
      // Product Inquiry
      emailSubject = `Product Inquiry: ${model || "N/A"} (${quantity || "N/A"} units)`;

      textContent = `
PRODUCT INQUIRY
================
Product: ${model || "N/A"}
Quantity: ${quantity || "N/A"} units
Shipping Terms: ${shippingTerm || "Not provided"}
----------------------------
Customer Details:
Name: ${name}
Email: ${email}
Phone: ${phone || "Not provided"}
${company ? `Company: ${company}` : ""}
Address: ${address || "Not provided"}
----------------------------
Customer Message:
${message}
================
      `;

      htmlContent = `
<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
  <h2 style="color: #e67e22; border-bottom: 2px solid #e67e22; padding-bottom: 5px;">PRODUCT INQUIRY</h2>

  <div style="background: #f5f5f5; padding: 15px; border-radius: 5px; margin-bottom: 15px;">
    <p><strong>Product:</strong> ${model || "N/A"}<br>
       <strong>Quantity:</strong> ${quantity || "N/A"} units<br>
       <strong>Shipping Terms:</strong> ${shippingTerm || "Not provided"}</p>
  </div>

  <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
    <tr style="background: #e67e22; color: white;">
      <th colspan="2" style="padding: 10px; text-align: left;">CUSTOMER DETAILS</th>
    </tr>
    <tr>
      <td style="padding: 10px; border: 1px solid #ddd; width: 30%;"><strong>Name:</strong></td>
      <td style="padding: 10px; border: 1px solid #ddd;">${name}</td>
    </tr>
    <tr>
      <td style="padding: 10px; border: 1px solid #ddd;"><strong>Email:</strong></td>
      <td style="padding: 10px; border: 1px solid #ddd;">${email}</td>
    </tr>
    <tr>
      <td style="padding: 10px; border: 1px solid #ddd;"><strong>Phone:</strong></td>
      <td style="padding: 10px; border: 1px solid #ddd;">${phone || "Not provided"}</td>
    </tr>
    ${
      company
        ? `<tr>
            <td style="padding: 10px; border: 1px solid #ddd;"><strong>Company:</strong></td>
            <td style="padding: 10px; border: 1px solid #ddd;">${company}</td>
          </tr>`
        : ""
    }
    <tr>
      <td style="padding: 10px; border: 1px solid #ddd;"><strong>Address:</strong></td>
      <td style="padding: 10px; border: 1px solid #ddd;">${address || "Not provided"}</td>
    </tr>
  </table>

  <div style="background: #f5f5f5; padding: 15px; border-radius: 5px;">
    <h4 style="margin-top: 0; color: #e67e22;">CUSTOMER MESSAGE:</h4>
    <p style="white-space: pre-wrap; margin-bottom: 0;">${message}</p>
  </div>
</div>
      `;
    } else {
      // General Inquiry
      emailSubject = subject || "New Inquiry from Website";
      textContent = `
NEW INQUIRY
================
Customer Details:
Name: ${name}
Email: ${email}
Phone: ${phone || "Not provided"}
${company ? `Company: ${company}` : ""}
----------------------------
Customer Message:
${message}
================
      `;

      htmlContent = `
<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
  <h2 style="color: #e67e22; border-bottom: 2px solid #e67e22; padding-bottom: 5px;">GENERAL INQUIRY</h2>

  <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
    <tr style="background: #e67e22; color: white;">
      <th colspan="2" style="padding: 10px; text-align: left;">CUSTOMER DETAILS</th>
    </tr>
    <tr>
      <td style="padding: 10px; border: 1px solid #ddd; width: 30%;"><strong>Name:</strong></td>
      <td style="padding: 10px; border: 1px solid #ddd;">${name}</td>
    </tr>
    <tr>
      <td style="padding: 10px; border: 1px solid #ddd;"><strong>Email:</strong></td>
      <td style="padding: 10px; border: 1px solid #ddd;">${email}</td>
    </tr>
    <tr>
      <td style="padding: 10px; border: 1px solid #ddd;"><strong>Phone:</strong></td>
      <td style="padding: 10px; border: 1px solid #ddd;">${phone || "Not provided"}</td>
    </tr>
    ${
      company
        ? `<tr>
            <td style="padding: 10px; border: 1px solid #ddd;"><strong>Company:</strong></td>
            <td style="padding: 10px; border: 1px solid #ddd;">${company}</td>
          </tr>`
        : ""
    }
  </table>

  <div style="background: #f5f5f5; padding: 15px; border-radius: 5px;">
    <h4 style="margin-top: 0; color: #e67e22;">CUSTOMER MESSAGE:</h4>
    <p style="white-space: pre-wrap; margin-bottom: 0;">${message}</p>
  </div>
</div>
      `;
    }

    await transporter.sendMail({
      from: `"Website Inquiry" <${process.env.SMTP_USER}>`,
      to: process.env.OWNER_EMAIL,
      subject: emailSubject,
      text: textContent,
      html: htmlContent,
    });

    res.status(200).json({ success: true });
  } catch (error) {
    console.error("Error sending email:", error);
    res.status(500).json({ success: false, error: "Failed to send email" });
  }
});

// Server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
