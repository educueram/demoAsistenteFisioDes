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
    PrecioServicio DECIMAL(10, 2) NOT NULL
);

CREATE TABLE Horarios (
    IdHorario INT PRIMARY KEY AUTO_INCREMENT,
    HoraInicio TIME NOT NULL,
    HoraFin TIME NOT NULL,
    Activo BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE Calendarios (
    IdCalendario INT PRIMARY KEY AUTO_INCREMENT,
    Fecha DATE NOT NULL,
    Descripcion VARCHAR(200),
    Activo BOOLEAN NOT NULL DEFAULT TRUE
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
