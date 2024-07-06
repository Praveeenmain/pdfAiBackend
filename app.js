require('dotenv').config();
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
const ytdl = require('ytdl-core');
const { createClient } = require("@deepgram/sdk");
// Create Express app
const app = express();
const port = 3001;

// OpenAI API setup
const OPENAI_API_KEY = process.env.OPENAI_API_KEY; // Make sure to set this environment variable
const openai = new OpenAI({
    apiKey: OPENAI_API_KEY // Use your actual API key here
});

// MySQL database connection configuration
const dbConfig = {
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    port: process.env.DB_PORT
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
const pool = mysql.createPool(dbConfig);


  
  
// Multer setup for handling file uploads
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'uploads/');
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + '-' + file.originalname);
    }
});

// Multer upload configuration with file size limits and error handling
const upload = multer({
    storage,
    fileFilter: function (req, file, cb) {
        if (file.mimetype.startsWith('audio') || file.mimetype === 'application/pdf' || file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
            cb(null, true);
        } else {
            cb(new Error('Unsupported file format. Supported formats: mp3, wav, ogg, pdf, docx, etc.'));
        }
    }
});

function formatDateToMySQL(datetime) {
    const pad = (number) => number.toString().padStart(2, '0');

    const year = datetime.getFullYear();
    const month = pad(datetime.getMonth() + 1);
    const day = pad(datetime.getDate());
    const hours = pad(datetime.getHours());
    const minutes = pad(datetime.getMinutes());
    const seconds = pad(datetime.getSeconds());

    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

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

// Function to transcribe audio using OpenAI


const audioFun = async (audioBuffer) => {
    try {
        // STEP 1: Create a Deepgram client using the API key
        const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

        // STEP 2: Call the transcribeFile method with the audio payload and options
        const { result, error } = await deepgram.listen.prerecorded.transcribeFile(
            audioBuffer, // Use the provided audio buffer
            {
                model: "nova-2",
                smart_format: true,
            }
        );

        // Log the result to understand its structure
        console.log("Transcription result:", result.results.channels[0].alternatives[0].transcript);

        // Extract words from the result object
        return result.results.channels[0].alternatives[0].transcript;

    } catch (error) {
        console.error("Error transcribing audio:", error);
        throw error;
    }
};




// New function to generate a title from the transcription text
const generateTitle = async (text) => {
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                {
                    role: "system",
                    content: "Generate a concise and informative title for the following text:"
                },
                {
                    role: "user",
                    content: text
                }
              
            ],
                language: "en"
        });
        return response.choices[0].message.content.trim();
    } catch (error) {
        console.error("Error generating title:", error);
        throw error;
    }
};






// Example: Handle a POST request with a JWT token in the body
// server.js

// Route to save token
app.post('/api/store-token', (req, res) => {
    const { name, email } = req.body;

    // Check if user with the provided email already exists
    const sqlCheck = 'SELECT * FROM users WHERE email = ?';
    connection.query(sqlCheck, [email], (err, rows) => {
        if (err) {
            console.error('Error checking user:', err);
            res.status(500).json({ error: 'Failed to store token' });
            return;
        }

        // If user with email exists, return an error
        if (rows.length > 0) {
            console.log('User with email already exists');
            res.status(200).json({ error: 'User with email already exists' });
            return;
        }

        // If user doesn't exist, insert the new user
        const sqlInsert = 'INSERT INTO users (name, email) VALUES (?,?)';
        connection.query(sqlInsert, [name, email], (err, result) => {
            if (err) {
                console.error('Error storing token:', err);
                res.status(500).json({ error: 'Failed to store token' });
            } else {
                console.log('Name and email stored successfully:', result);
                res.status(200).json({ message: 'Token stored successfully' });
            }
        });
    });
});

// Endpoint to upload and transcribe audio
app.post('/upload-transcribe', (req, res) => {
    upload.single('audio')(req, res, async (err) => {
        if (err) {
            console.error('Error uploading file:', err);
            return res.status(500).send('Error uploading file.');
        }

        try {
            if (!req.file) {
                return res.status(400).send('No audio file uploaded.');
            }

            const audioPath = req.file.path;
            const audioReadStream = fs.createReadStream(audioPath);
            const transcriptionText = await audioFun(audioReadStream);
            if (!transcriptionText) {
                return res.status(500).send('Error in transcription.');
            }

            const title = await generateTitle(transcriptionText);
            const embedding = await generateEmbedding(transcriptionText);
            const currentDate = new Date();

            // Read audio file as buffer
            const audioBuffer = fs.readFileSync(audioPath);

            // Insert into SQL database
            const sql = 'INSERT INTO Audio (title, transcription, audio, embedding, date) VALUES (?, ?, ?, ?, ?)';
            const values = [title, transcriptionText, audioBuffer, JSON.stringify(embedding), currentDate];
            await query(sql, values);

            // Clean up: delete uploaded file
            fs.unlinkSync(audioPath);

            res.status(200).json({
                title: title,
                transcription: transcriptionText,
                date: currentDate
            });

        } catch (error) {
            console.error('Error processing request:', error);
            res.status(500).send('Error processing request.');
        }
    });
});

// Endpoint to ask a question based on stored audio transcription
app.post('/audioask/:id', async (req, res) => {
    try {
        const { question } = req.body;
        const id = req.params.id;

        if (!question) {
            return res.status(400).send('Question is required.');
        }

        // Generate embedding for the question
        const questionEmbedding = await generateEmbedding(question);

        // Retrieve stored transcription and embedding from the database
        const sql = "SELECT transcription, embedding FROM Audio WHERE id = ?";
        connection.query(sql, [id], async (err, results) => {
            if (err) {
                console.error('Error querying database:', err);
                return res.status(500).json({ error: 'Error querying database' });
            }

            if (results.length === 0) {
                return res.status(404).json({ error: 'No data found for the provided ID' });
            }

            try {
                const transcription = results[0].transcription;
                const embedding = JSON.parse(results[0].embedding);

                // Calculate similarity between question embedding and audio embedding
                const similarity = cosineSimilarity(questionEmbedding, embedding);

                // Use OpenAI to generate a response based on the retrieved transcription and the question
                const response = await openai.chat.completions.create({
                    model: "gpt-4o",
                    messages: [
                        { role: "system", content: "You are a helpful assistant." },
                        { role: "user", content: `Answer the question based on the following context:\n\n${transcription}\n\nQuestion: ${question}` }
                    ],
                    max_tokens: 200
                });

                const answer = response.choices[0].message.content.trim();
                res.status(200).json({ answer: answer, similarity: similarity });
            } catch (error) {
                console.error('Error generating response:', error);
                res.status(500).json({ error: 'Error generating response' });
            }
        });
    } catch (error) {
        console.error('Error processing request:', error);
        res.status(500).json({ error: 'Error processing request' });
    }
});

app.get('/audiofiles', async (req, res) => {
    try {
        // Query to retrieve id, title, and date from myvectortable
        const sql = "SELECT id, title, date FROM Audio";

        // Execute query
        const results = await query(sql);

        // Return list of id, title, and date
        res.status(200).json(results);
    } catch (error) {
        console.error('Error fetching Audio list:', error);
        res.status(500).json({ error: 'Error fetching Audio list' });
    }
});
app.get('/audiofile/:id', async (req, res) => {
    const { id } = req.params;

    try {
        // Query to retrieve title, date, and other information from myvectortable based on id
        const sql = "SELECT * FROM Audio WHERE id = ?";
        
        // Execute query with id as parameter
        const results = await query(sql, [id]);

        // Check if results are empty
        if (results.length === 0) {
            return res.status(404).json({ error: 'Audio not found' });
        }

        // Return title, date, and other information
        const AudioFile = results[0];
        res.status(200).json({ AudioFile });
    } catch (error) {
        console.error('Error fetching Audio:', error);
        res.status(500).json({ error: 'Error fetching Audiofiles' });
    }
});

app.delete('/audiofile/:id', async (req, res) => {
    const { id } = req.params;

    try {
        // Query to delete the record from myvectortable based on id
        const sql = "DELETE FROM Audio WHERE id = ?";

        // Execute query with id as parameter
        const result = await query(sql, [id]);

        // Check if any rows were affected (i.e., if the record was deleted)
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Audio not found' });
        }

        // Return a success message
        res.status(200).json({ message: 'Audio deleted successfully' });
    } catch (error) {
        console.error('Error deleting PDF:', error);
        res.status(500).json({ error: 'Error deleting Audio' });
    }
});



// PUT endpoint for updating audio file title by ID
app.put('/updateTitle/:id', (req, res) => {
    const audioId = req.params.id;
    const { title } = req.body; // Assuming you only want to update the title
    
    // Validate audioId as an integer (assuming id is numeric)
    if (isNaN(audioId)) {
      return res.status(400).json({ message: 'Invalid audio file ID.' });
    }
    
    // Validate title
    if (!title || typeof title !== 'string') {
      return res.status(400).json({ message: 'Invalid or missing title.' });
    }
    
    // Query to update the audio file title
    const sql = 'UPDATE Audio SET title = ? WHERE id = ?';
    
    // Execute the query
    pool.query(sql, [title, audioId], (error, results) => {
      if (error) {
        console.error('Error updating audio file:', error);
        return res.status(500).json({ message: 'Error updating audio file.', error: error.message });
      }
    
      // Check if the audio file was found and updated
      if (results.affectedRows === 0) {
        return res.status(404).json({ message: 'Audio file not found.' });
      }
    
      // Audio file title updated successfully
      res.status(200).json({ message: 'Audio file title updated successfully.' });
    });
  });
  
  
  
  

// Endpoint to upload and store notes
app.post('/uploadnotes', upload.array('files', 3), async (req, res) => {
    try {
        const files = req.files; // Array of uploaded files
        const { title, category, exam, paper, subject, topics } = req.body; // Assuming these fields are sent in the request body

        if (!files || files.length === 0) {
            return res.status(400).json({ error: 'No files uploaded' });
        }

        if (!title || !category || !exam || !paper || !subject || !topics) {
            return res.status(400).json({ error: 'All fields (title, category, exam, paper, subject, topics) are required' });
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
        const sql = "INSERT INTO myvectortable (title, category, exam, paper, subject, topics, text, vector) VALUES (?, ?, ?, ?, ?, ?, ?, ?)";
        const values = [title, category, exam, paper, subject, topics, combinedText.trim(), JSON.stringify(embedding)];

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

//youtube videos

app.post('/youtube-transcribe', async (req, res) => {
    const { videoUrl } = req.body;

    if (!videoUrl || !ytdl.validateURL(videoUrl)) {
        return res.status(400).send('Invalid YouTube video URL.');
    }

    try {
        // Download the audio from the YouTube video
        const audioPath = `uploads/${Date.now()}.mp3`;
        const audioStream = ytdl(videoUrl, { filter: 'audioonly' }).pipe(fs.createWriteStream(audioPath));

        audioStream.on('finish', async () => {
            try {
                const audioReadStream = fs.createReadStream(audioPath);
                const transcriptionText = await audioFun(audioReadStream);
                if (!transcriptionText) {
                    return res.status(500).send('Error in transcription.');
                }

                const title = await generateTitle(transcriptionText);
                const embedding = await generateEmbedding(transcriptionText);
                const currentDate = new Date();

                // Insert into SQL database
                const sql = 'INSERT INTO YouTube (title, transcription, videoUrl, embedding, date) VALUES (?, ?, ?, ?, ?)';
                const values = [title, transcriptionText, videoUrl, JSON.stringify(embedding), currentDate];
                await query(sql, values);

                // Clean up: delete downloaded file
                fs.unlinkSync(audioPath);

                res.status(200).json({
                    title: title,
                    transcription: transcriptionText,
                    date: currentDate
                });
            } catch (error) {
                console.error('Error processing request:', error);
                res.status(500).send('Error processing request.');
            }
        });

        audioStream.on('error', (error) => {
            console.error('Error downloading YouTube audio:', error);
            res.status(500).send('Error downloading YouTube audio.');
        });
    } catch (error) {
        console.error('Error processing request:', error);
        res.status(500).send('Error processing request.');
    }
});

app.post('/youtube-ask/:id', async (req, res) => {
    const { question } = req.body;
    const id = req.params.id;

    if (!question || !id) {
        return res.status(400).json({ error: 'Question and ID are required' });
    }

    try {
        const questionEmbedding = await generateEmbedding(question);

        // Retrieve specific embedding and transcription from the YouTube table based on ID
        const sql = "SELECT transcription, embedding FROM YouTube WHERE id = ?";
        connection.query(sql, [id], async (err, results) => {
            if (err) {
                console.error('Error querying database:', err);
                res.status(500).json({ error: 'Error querying database' });
                return;
            }

            console.log('Query results:', results);  // Debug log

            if (results.length === 0) {
                return res.status(404).json({ error: 'No data found for the provided ID' });
            }

            // Extract transcription and embedding from the result
            const transcription = results[0].transcription;
            const embedding = JSON.parse(results[0].embedding);

            // Calculate similarity with the retrieved embedding
            const similarity = cosineSimilarity(questionEmbedding, embedding);

            // Use OpenAI to generate a response based on the retrieved transcription
            openai.chat.completions.create({
                model: "gpt-4o",
                messages: [
                    { role: "system", content: "You are a helpful assistant." },
                    { role: "user", content: `Answer the question based on the following context:\n\n${transcription}\n\nQuestion: ${question}` }
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

app.get('/videos', async (req, res) => {
    try {
        // Query to retrieve id, title, and date from YouTube table
        const sql = "SELECT id, title, date FROM YouTube";

        // Execute query using util.promisify with connection.query
        const results = await query(sql);

        // Return list of id, title, and date
        res.status(200).json(results);
    } catch (error) {
        console.error('Error fetching YouTube list:', error);
        res.status(500).json({ error: 'Error fetching YouTube list' });
    }
});

// Assuming you have already defined 'query' and 'app' in your code

// API endpoint to fetch a video by id
app.get('/videos/:id', async (req, res) => {
    const videoId = req.params.id; // Retrieve id from URL parameter

    try {
        // Query to retrieve video by id from YouTube table
        const sql = "SELECT * FROM YouTube WHERE id = ?";

        // Execute query using util.promisify with connection.query
        const results = await query(sql, [videoId]);

        // Check if video with the given id exists
        if (results.length === 0) {
            return res.status(404).json({ error: 'Video not found' });
        }

        // Return the video object
        res.status(200).json(results[0]); // Assuming id is unique, so only one result

    } catch (error) {
        console.error('Error fetching YouTube video:', error);
        res.status(500).json({ error: 'Error fetching YouTube video' });
    }
});

// Assuming you have already defined 'query' and 'app' in your code

// API endpoint to delete a video by id
app.delete('/videos/:id', async (req, res) => {
    const videoId = req.params.id; // Retrieve id from URL parameter

    try {
        // Query to delete video by id from YouTube table
        const sql = "DELETE FROM YouTube WHERE id = ?";

        // Execute query using util.promisify with connection.query
        const results = await query(sql, [videoId]);

        // Check if a video was deleted (results.affectedRows will be 1 if deleted)
        if (results.affectedRows === 0) {
            return res.status(404).json({ error: 'Video not found' });
        }

        // Return success message
        res.status(200).json({ message: 'Video deleted successfully' });

    } catch (error) {
        console.error('Error deleting YouTube video:', error);
        res.status(500).json({ error: 'Error deleting YouTube video' });
    }
});

//Class Tests
app.post('/uploadpapers', upload.array('files', 3), async (req, res) => {
    try {
        const files = req.files; // Array of uploaded files

        if (!files || files.length === 0) {
            return res.status(400).json({ error: 'No files uploaded' });
        }

        let combinedText = ''; // Variable to store the combined text from all files

        for (const file of files) {
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

        // Generate a title based on the combined text
        const generatedTitle = await generateTitle(combinedText);

        // Generate embedding from the combined text
        const embedding = await generateEmbedding(combinedText);

        // Get the current date
        const currentDate = formatDateToMySQL(new Date());

        // Prepare SQL statement for insertion into 'previouspapers' table using parameterized query
        const sql = "INSERT INTO previouspapers (title, text, vector, date) VALUES (?, ?, ?, ?)";
        const values = [generatedTitle, combinedText.trim(), JSON.stringify(embedding), currentDate];

        // Log values to debug any potential issues
        console.log('SQL Query:', sql);
        console.log('Values:', values);

        // Insert the combined text and embedding into the 'previouspapers' table
        connection.query(sql, values, (err, results) => {
            if (err) {
                console.error('Error storing file embedding:', err.message);
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

app.post('/askprevious/:id', async (req, res) => {
    const { question } = req.body;
    const id = req.params.id;

    if (!question || !id) {
        return res.status(400).json({ error: 'Question and ID are required' });
    }

    try {
        const questionEmbedding = await generateEmbedding(question);

        // Retrieve specific text from the 'previouspapers' table based on ID
        const sql = "SELECT text FROM previouspapers WHERE id = ?";
        connection.query(sql, [id], async (err, results) => {
            if (err) {
                console.error('Error querying database:', err);
                return res.status(500).json({ error: 'Error querying database' });
            }

            if (results.length === 0) {
                return res.status(404).json({ error: 'No data found for the provided ID' });
            }

            // Extract text from the result
            const text = results[0].text;

            // Use OpenAI to generate a new question based on the retrieved text
            try {
                const response = await openai.chat.completions.create({
                    model: "gpt-4o",
                    messages: [
                        { role: "system", content: "Generate new questions based on the provided message:" },
                        { role: "user", content: text }
                    ],
                    max_tokens: 100
                });

                const generatedQuestion = response.choices[0].message.content.trim();

                // Now, use the generated question to calculate similarity with the provided question
                const generatedQuestionEmbedding = await generateEmbedding(generatedQuestion);
                const similarity = cosineSimilarity(questionEmbedding, generatedQuestionEmbedding);

                res.status(200).json({ generatedQuestion: generatedQuestion, similarity: similarity });
            } catch (error) {
                console.error('Error generating response:', error);
                res.status(500).json({ error: 'Error generating response' });
            }
        });
    } catch (error) {
        console.error('Error processing request:', error);
        res.status(500).json({ error: 'Error processing request' });
    }
});


app.get('/pqfiles', (req, res) => {
    const sql = "SELECT id, title, date FROM previouspapers";

    connection.query(sql, (err, results) => {
        if (err) {
            console.error('Error querying database:', err);
            return res.status(500).json({ error: 'Error querying database' });
        }

        res.status(200).json(results);
    });
});

app.get('/pqfile/:id', (req, res) => {
    const id = req.params.id;

    const sql = "SELECT * FROM previouspapers WHERE id = ?";
    connection.query(sql, [id], (err, results) => {
        if (err) {
            console.error('Error querying database:', err);
            return res.status(500).json({ error: 'Error querying database' });
        }

        if (results.length === 0) {
            return res.status(404).json({ error: 'No data found for the provided ID' });
        }

        res.status(200).json(results[0]);
    });
});

app.delete('/pqfile/:id', (req, res) => {
    const id = req.params.id;

    const sql = "DELETE FROM previouspapers WHERE id = ?";
    connection.query(sql, [id], (err, results) => {
        if (err) {
            console.error('Error querying database:', err);
            return res.status(500).json({ error: 'Error querying database' });
        }

        if (results.affectedRows === 0) {
            return res.status(404).json({ error: 'No data found for the provided ID' });
        }

        res.status(200).json({ message: 'File deleted successfully' });
    });
});


app.post('/askdb', async (req, res) => {
    const { question } = req.body;
  
    if (!question) {
      return res.status(400).json({ error: 'Question is required' });
    }
  
    try {
      const questionEmbedding = await generateEmbedding(question);
  
      const query = util.promisify(connection.query).bind(connection);
  
      const results = await Promise.all([
        query("SELECT text, vector FROM myvectortable"),
        query("SELECT transcription, embedding FROM YouTube"),
        query("SELECT text, vector FROM previouspapers"),
        query("SELECT transcription, embedding FROM Audio")
      ]);
  
      const [myvectortableResults, youTubeResults, previousPapersResults, audioResults] = results;
  
      let combinedAnswer = '';
      let combinedSimilarity = 0;
      const dataSources = [
        { results: myvectortableResults, fieldText: 'text', fieldVector: 'vector' },
        { results: youTubeResults, fieldText: 'transcription', fieldVector: 'embedding' },
        { results: previousPapersResults, fieldText: 'text', fieldVector: 'vector' },
        { results: audioResults, fieldText: 'transcription', fieldVector: 'embedding' }
      ];
  
      for (const { results: dataSource, fieldText, fieldVector } of dataSources) {
        if (dataSource.length > 0) {
          const { [fieldText]: context, [fieldVector]: embedding } = dataSource[0];
  
          const openaiResponse = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
              { role: "system", content: "give short in 2-4 lines." },
              { role: "user", content: `Answer the question based on the following context:\n\n${context}\n\nQuestion: ${question}` }
            ],
            max_tokens: 200
          });
  
          const answer = openaiResponse.choices[0].message.content.trim();
          const similarity = 0.7; // Placeholder, replace with actual similarity calculation
  
          // Combine results with weighted similarity
          combinedAnswer += `${answer}\n\n`;
          combinedSimilarity += similarity * (1 / dataSources.length); // Weight by number of sources
        }
      }
  
      res.status(200).json({ answer: combinedAnswer.trim(), similarity: combinedSimilarity });
    } catch (error) {
      console.error('Error processing request:', error);
      res.status(500).json({ error: 'Error processing request' });
    }
  });



// Start the server
app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});
