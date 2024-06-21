const express = require('express');
const mysql = require('mysql');
const multer = require('multer');
const cors = require('cors');
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
const OPENAI_API_KEY = process.env.OPENAI_API_KEY; // Make sure to set this environment variable
const openai = new OpenAI({
    apiKey: OPENAI_API_KEY // Use your actual API key here
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
app.use(cors());
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
//pdf upload  route

// Route for uploading PDF files with title and automatically generated date metadata
app.post('/upload', upload.single('pdfFile'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        const { title } = req.body; // Extract title from request body
        const pdfPath = req.file.path; // File path where the uploaded PDF is stored

        // Extract text from PDF file
        const pdfText = await extractTextFromPDF(pdfPath);

        // Generate embedding from extracted text
        const embedding = await generateEmbedding(pdfText);

        // Store in database (myvectortable)
        const sql = "INSERT INTO myvectortable (title, text, vector) VALUES (?, ?, ?)";
        const values = [title, pdfText, JSON.stringify(embedding)];

        connection.query(sql, values, (err, results) => {
            if (err) {
                console.error('Error storing PDF embedding:', err);
                res.status(500).json({ error: 'Error storing PDF embedding' });
                return;
            }
            console.log('PDF embedding stored successfully');
            res.status(200).json({ message: 'PDF uploaded and processed successfully' });
        });

    } catch (error) {
        console.error('Error uploading PDF:', error);
        res.status(500).json({ error: 'Error uploading PDF' });
    } finally {
        // Clean up: Delete the uploaded file from disk
        if (req.file) {
            const filePath = path.join(__dirname, req.file.path);
            fs.unlinkSync(filePath); // Delete the file synchronously
        }
    }
});



//with chatgpt embeedings
app.post('/ask/:id', async (req, res) => {
    const { question } = req.body;
    const id = req.params.id;

    if (!question || !id) {
        return res.status(400).json({ error: 'Question and ID are required' });
    }

    try {
        const questionEmbedding = await generateEmbedding(question);

        // Retrieve specific embedding and text from the database based on ID
        const sql = "SELECT text, vector FROM myvectortable WHERE id = ?";
        connection.query(sql, [id], async (err, results) => {
            if (err) {
                console.error('Error querying database:', err);
                res.status(500).json({ error: 'Error querying database' });
                return;
            }

            if (results.length === 0) {
                return res.status(404).json({ error: 'No data found for the provided ID' });
            }

            // Extract text and vector from the result
            const text = results[0].text;
            const vector = JSON.parse(results[0].vector);

            // Calculate similarities with the retrieved text
            const similarity = cosineSimilarity(questionEmbedding, vector);

            // Use OpenAI to generate a response based on the retrieved text
            openai.chat.completions.create({
                model: "gpt-4o",
                messages: [
                    { role: "system", content: "You are a helpful assistant." },
                    { role: "user", content: `Answer the question based on the following context:\n\n${text}\n\nQuestion: ${question}` }
                ],
                max_tokens: 200
            }).then(response => {
                const answer = response.choices[0].message.content.trim();
                res.status(200).json({ answer: answer, similarity: similarity });
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

app.get('/pdf-list', async (req, res) => {
    try {
        // Query to retrieve id, title, and date from myvectortable
        const sql = "SELECT id, title, date FROM myvectortable";

        // Execute query
        const results = await query(sql);

        // Return list of id, title, and date
        res.status(200).json({ pdfFiles: results });
    } catch (error) {
        console.error('Error fetching PDF list:', error);
        res.status(500).json({ error: 'Error fetching PDF list' });
    }
});


app.get('/pdf/:id', async (req, res) => {
    const { id } = req.params;

    try {
        // Query to retrieve title, date, and other information from myvectortable based on id
        const sql = "SELECT id, title, date FROM myvectortable WHERE id = ?";
        
        // Execute query with id as parameter
        const results = await query(sql, [id]);

        // Check if results are empty
        if (results.length === 0) {
            return res.status(404).json({ error: 'PDF not found' });
        }

        // Return title, date, and other information
        const pdfFile = results[0];
        res.status(200).json({ pdfFile });
    } catch (error) {
        console.error('Error fetching PDF:', error);
        res.status(500).json({ error: 'Error fetching PDF' });
    }
});

app.delete('/pdf/:id', async (req, res) => {
    const { id } = req.params;

    try {
        // Query to delete the PDF file from myvectortable based on id
        const sql = "DELETE FROM myvectortable WHERE id = ?";
        
        // Execute delete query with id as parameter
        const result = await query(sql, [id]);

        // Check if no rows were affected (PDF with given id not found)
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'PDF not found' });
        }

        // Return success message
        res.status(200).json({ message: 'PDF deleted successfully' });
    } catch (error) {
        console.error('Error deleting PDF:', error);
        res.status(500).json({ error: 'Error deleting PDF' });
    }
});





// Start the server
app.listen(port, () => {
    console.log(`Server is running at http://localhost:${port}`);
});
