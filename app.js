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
const mammoth = require('mammoth');
const util = require('util');
const upload = multer({ dest: 'uploads/' });
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


// Function to extract text from PDF file using pdf-parse


// Function to extract text from DOC file using mammoth


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

// Function to extract text from DOC file using mammoth
const extractTextFromDOC = async (docPath) => {
    try {
        const result = await mammoth.extractRawText({ path: docPath });
        return result.value;
    } catch (error) {
        console.error('Error extracting text from DOC:', error);
        throw error;
    }
};

app.post('/uploadnotes', upload.array('files', 5), async (req, res) => {
    try {
        const files = req.files; // Array of uploaded files
        const { title } = req.body; // Assuming title is the same for all files

        if (!files || files.length === 0) {
            return res.status(400).json({ error: 'No files uploaded' });
        }

        if (!title) {
            return res.status(400).json({ error: 'Title is required' });
        }

        let combinedText = ''; // Variable to store the combined text from all files

        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const filePath = file.path;
            const fileMimeType = file.mimetype;
            try {
                let fileText;

                // Determine the file type and extract text accordingly
                if (fileMimeType === 'application/pdf') {
                    fileText = await extractTextFromPDF(filePath);
                } else if (fileMimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
                    fileText = await extractTextFromDOC(filePath);
                } else {
                    throw new Error(`Unsupported file type: ${fileMimeType}`);
                }

                // Append the extracted text to the combined text
                combinedText += fileText + ' ';

                // Clean up: Delete the uploaded file from disk after processing
                fs.unlinkSync(filePath);

            } catch (error) {
                console.error('Error processing file:', error);
                // Clean up: Delete the uploaded file from disk if an error occurs
                fs.unlinkSync(filePath);
                throw error; // Rethrow the error to be caught in the main try-catch block
            }
        }

        // Generate embedding from the combined text
        const embedding = await generateEmbedding(combinedText);

        // Prepare SQL statement for insertion
        const sql = "INSERT INTO myvectortable (title, text, vector) VALUES (?, ?, ?)";
        const values = [title, combinedText.trim(), JSON.stringify(embedding)];

        // Insert the combined text and embedding into the database
        connection.query(sql, values, (err, results) => {
            if (err) {
                console.error('Error storing file embedding:', err);
                return res.status(500).json({ error: 'Error storing file embedding' });
            } else {
                console.log('File embedding stored successfully');
                res.status(200).json({ message: 'Files uploaded and processed successfully' });
            }
        });

    } catch (error) {
        console.error('Error uploading files:', error);
        res.status(500).json({ error: 'Error uploading files' });
    }
});


//ute to ask a question about a specific file
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

// Route to get list of PDFs
app.get('/notefiles', async (req, res) => {
    try {
        // Query to retrieve id, title, and date from myvectortable
        const sql = "SELECT id, title, date FROM myvectortable";

        // Execute query
        const results = await query(sql);

        // Return list of id, title, and date
        res.status(200).json(results);
    } catch (error) {
        console.error('Error fetching PDF list:', error);
        res.status(500).json({ error: 'Error fetching PDF list' });
    }
});
app.get('/notefile/:id', async (req, res) => {
    const { id } = req.params;

    try {
        // Query to retrieve title, date, and other information from myvectortable based on id
        const sql = "SELECT * FROM myvectortable WHERE id = ?";
        
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

app.delete('/notefile/:id', async (req, res) => {
    const { id } = req.params;

    try {
        // Query to delete the record from myvectortable based on id
        const sql = "DELETE FROM myvectortable WHERE id = ?";

        // Execute query with id as parameter
        const result = await query(sql, [id]);

        // Check if any rows were affected (i.e., if the record was deleted)
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'PDF not found' });
        }

        // Return a success message
        res.status(200).json({ message: 'PDF deleted successfully' });
    } catch (error) {
        console.error('Error deleting PDF:', error);
        res.status(500).json({ error: 'Error deleting PDF' });
    }
});

// Start the server
app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});
