-- Esquema base para demoAsistenteFisioDes

CREATE TABLE Clientes (
    IdCliente INT PRIMARY KEY AUTO_INCREMENT,
    NombreCompleto VARCHAR(150) NOT NULL,
    NumeroCelular VARCHAR(30) NOT NULL,
    CorreoElectronico VARCHAR(150) NOT NULL,
    UNIQUE (CorreoElectronico)
);

CREATE TABLE Especialistas (
    IdEspecialista INT PRIMARY KEY AUTO_INCREMENT,
    NombreCompleto VARCHAR(150) NOT NULL,
    CorreoElectronico VARCHAR(150),
    NumeroCelular VARCHAR(30)
);

CREATE TABLE Servicios (
    IdServicio INT PRIMARY KEY AUTO_INCREMENT,
    NombreServicio VARCHAR(150) NOT NULL,
    PrecioServicio DECIMAL(10, 2) NOT NULL,
    DuracionMinutos INT NOT NULL DEFAULT 60
);

CREATE TABLE Horarios (
    IdHorario INT PRIMARY KEY AUTO_INCREMENT,
    IdCalendario INT NOT NULL,
    DiaSemana INT NOT NULL, -- 1=Lunes, 2=Martes, ... 7=Domingo
    HoraInicio TIME NOT NULL,
    HoraFin TIME NOT NULL,
    Activo BOOLEAN NOT NULL DEFAULT TRUE,
    FOREIGN KEY (IdCalendario) REFERENCES Calendario(id_calendario)
);

CREATE TABLE Calendario (
    id_calendario INT AUTO_INCREMENT PRIMARY KEY,
    id_especialista INT NOT NULL,
    google_calendar_id VARCHAR(255) NOT NULL,
    nombre VARCHAR(150) NOT NULL,
    activo TINYINT(1) NOT NULL DEFAULT 1,
    fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_google_calendar (google_calendar_id),
    CONSTRAINT fk_calendario_especialista
        FOREIGN KEY (id_especialista)
        REFERENCES Especialistas(IdEspecialista)
);

CREATE TABLE Citas (
    IdCita INT PRIMARY KEY AUTO_INCREMENT,
    FechaRegistro DATETIME NOT NULL,
    CodigoReserva VARCHAR(50) NOT NULL,
    IdCliente INT NOT NULL,
    IdEspecialista INT NOT NULL,
    IdServicio INT NOT NULL,
    FechaCita DATE NOT NULL,
    HoraCita TIME NOT NULL,
    Estado VARCHAR(30) NOT NULL,
    Observaciones VARCHAR(300),
    UNIQUE (CodigoReserva),
    CONSTRAINT FK_Citas_Clientes
        FOREIGN KEY (IdCliente) REFERENCES Clientes(IdCliente),
    CONSTRAINT FK_Citas_Especialistas
        FOREIGN KEY (IdEspecialista) REFERENCES Especialistas(IdEspecialista),
    CONSTRAINT FK_Citas_Servicios
        FOREIGN KEY (IdServicio) REFERENCES Servicios(IdServicio)
);
