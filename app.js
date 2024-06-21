const express = require('express');
const mysql = require('mysql');
const multer = require('multer');
const pdf = require('pdf-parse');
const OpenAI = require('openai');
const cosineSimilarity = require('compute-cosine-similarity');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const util = require('util');
// Create Express app
const app = express();
const port = 3002;

// OpenAI API setup
const OPENAI_API_KEY = process.env.OPENAI_API_KEY; 
const openai = new OpenAI({
    apiKey: OPENAI_API_KEY
});

// MySQL database connection configuration
const dbConfig = {
    host: 'svc-9f73fbe3-1953-4c37-8f05-ec27251992ee-dml.aws-oregon-4.svc.singlestore.com',
    user: 'admin',
    password: 'Praveen.123',
    database: 'pdf',
    port: 3306 // SingleStore default port
};
const connection = mysql.createConnection(dbConfig);
const query = util.promisify(connection.query).bind(connection);
// Connect to the database
connection.connect((err) => {
    if (err) {
        console.error('Error connecting to database:', err);
        throw err;
    }
    console.log('Connected to MySQL database');
});

// Middleware to parse JSON request bodies
app.use(bodyParser.json());

// Multer setup for handling file uploads
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'uploads/');
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + '-' + file.originalname);
    }
});

const upload = multer({ storage: storage });

// Function to extract text from PDF file using pdf-parse
const extractTextFromPDF = async (pdfPath) => {
    try {
        const dataBuffer = fs.readFileSync(pdfPath);
        const pdfData = await pdf(dataBuffer);
        return pdfData.text;
    } catch (error) {
        console.error('Error extracting text from PDF:', error);
        throw error;
    }
};

// Function to generate embeddings using OpenAI's embedding model
const generateEmbedding = async (text) => {
    try {
        const response = await openai.embeddings.create({
            model: "text-embedding-ada-002",
            input: text
        });
        return response.data[0].embedding;
    } catch (error) {
        console.error("Error generating embedding:", error);
        throw error;
    }
};

// Function to store PDF embeddings in the database
const storePdfEmbedding = async (pdfPath) => {
    const pdfText = await extractTextFromPDF(pdfPath);
    const embedding = await generateEmbedding(pdfText);

    // Store the text and embedding in the database
    const sql = "INSERT INTO myvectortable (text, vector) VALUES (?, ?)";
    const values = [pdfText, JSON.stringify(embedding)];
    connection.query(sql, values, (err, results) => {
        if (err) throw err;
        console.log('Embedding stored successfully');
    });
};

// Route to handle file upload
app.post('/upload', upload.single('pdfFile'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        const pdfPath = req.file.path;
        await storePdfEmbedding(pdfPath);
        res.status(200).json({ message: 'PDF uploaded and processed successfully' });
    } catch (error) {
        console.error('Error uploading PDF:', error);
        res.status(500).json({ error: 'Error uploading PDF' });
    }
});

// Route to handle chatbot interaction
app.post('/ask', async (req, res) => {
    const { question } = req.body;

    if (!question) {
        return res.status(400).json({ error: 'No question provided' });
    }

    try {
        const questionEmbedding = await generateEmbedding(question);

        // Retrieve all embeddings and text from the database
        connection.query("SELECT text, vector FROM myvectortable", (err, results) => {
            if (err) throw err;

            let textChunks = [];
            let textEmbeddings = [];

            for (let row of results) {
                textChunks.push(row.text);
                textEmbeddings.push(JSON.parse(row.vector));
            }

            // Find the most similar text chunk
            let similarities = textEmbeddings.map(emb => cosineSimilarity(questionEmbedding, emb));
            let mostSimilarIndex = similarities.indexOf(Math.max(...similarities));
            let mostSimilarText = textChunks[mostSimilarIndex];
            
            // Use OpenAI to generate a response based on the most similar text
            openai.chat.completions.create({
                model: "gpt-4o",
                messages: [
                    { role: "system", content: "You are a helpful assistant." },
                    { role: "user", content: `Answer the question based on the following context:\n\n${mostSimilarText}\n\nQuestion: ${question}` }
                ],
                max_tokens: 200
            }).then(response => {
                const answer = response.choices[0].message.content.trim();
                res.status(200).json({ answer: answer });
            }).catch(error => {
                console.error('Error generating response:', error);
                res.status(500).json({ error: 'Error generating response' });
            });
        });
    } catch (error) {
        console.error('Error processing request:', error);
        res.status(500).json({ error: 'Error processing request' });
    }
});


// Start the server
app.listen(port, () => {
    console.log(`Server is running at http://localhost:${port}`);
});
