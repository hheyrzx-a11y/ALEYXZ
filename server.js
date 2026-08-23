// server.js
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const patchVideo = require('./patcher');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Configurar multer para guardar archivos temporalmente
const upload = multer({ dest: 'uploads/' });

app.use(cors());
// Servir la página web estática
app.use(express.static('public'));

// Crear directorio de uploads si no existe
if (!fs.existsSync('uploads')){
    fs.mkdirSync('uploads');
}

// Ruta que recibe el video y lo procesa
app.post('/api/patch', upload.single('video'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No se subió ningún archivo' });
    }

    const inputPath = req.file.path;
    const originalName = req.file.originalname;
    const outputPath = `${inputPath}_patched.mp4`;

    try {
        // 1. Leer el archivo subido a memoria
        const fileBuffer = fs.readFileSync(inputPath);
        const uint8Array = new Uint8Array(fileBuffer);

        // 2. Ejecutar el parche
        const patchedUint8Array = patchVideo(uint8Array);

        // 3. Escribir el resultado a un nuevo archivo temporal
        fs.writeFileSync(outputPath, patchedUint8Array);

        // 4. Enviar el archivo al cliente
        res.download(outputPath, `aleyxz_${originalName}`, (err) => {
            // 5. ¡ELIMINACIÓN AUTOMÁTICA DEL SERVIDOR!
            // Esto ocurre independientemente de si la descarga fue exitosa o falló
            try {
                if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
                if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
                console.log(`Archivos temporales eliminados para: ${originalName}`);
            } catch (cleanupErr) {
                console.error("Error al limpiar archivos:", cleanupErr);
            }
        });

    } catch (error) {
        console.error("Error procesando video:", error);
        
        // Si hay error, intentar borrar el archivo subido
        if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
        
        res.status(500).json({ error: 'Fallo al procesar el video: ' + error.message });
    }
});

app.listen(PORT, () => {
    console.log(`Servidor ALEYXZ corriendo en el puerto ${PORT}`);
});

